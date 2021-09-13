import * as k8s from '@kubernetes/client-node'
import { ChannelOptions, StatusObject, Metadata } from '@grpc/grpc-js'
import {
  registerResolver,
  Resolver,
  ResolverListener,
} from '@grpc/grpc-js/build/src/resolver'
import { SubchannelAddress } from '@grpc/grpc-js/build/src/subchannel'
import {
  GrpcUri,
  splitHostPort,
  uriToString,
} from '@grpc/grpc-js/build/src/uri-parser'
import * as logging from '@grpc/grpc-js/build/src/logging'
import { LogVerbosity, Status } from '@grpc/grpc-js/build/src/constants'

const defaultRefreshFreq = 1000 * 60 * 30 // 30min
const TRACER_NAME = 'k8s_resolver'

const trace = (text: string) => {
  logging.trace(LogVerbosity.DEBUG, TRACER_NAME, text)
}

export const K8sScheme = 'k8s'

const fieldSelectorPrefix = 'metadata.name='

const kc = new k8s.KubeConfig()
kc.loadFromDefault()
const k8sApi = kc.makeApiClient(k8s.CoreV1Api)

export class K8sResolover implements Resolver {
  private error: StatusObject | null = null
  private defaultResolutionError: StatusObject

  private processing: boolean = false
  private timer: ReturnType<typeof setInterval>

  private namespace: string
  private port: number
  private serviceName: string
  private addresses = new Set<string>()
  private informer: k8s.Informer<k8s.V1Endpoints>

  constructor(
    private target: GrpcUri,
    private listener: ResolverListener,
    _channelOptions: ChannelOptions // eslint-disable-line
  ) {
    trace('Resolver constructed for target ' + uriToString(target))
    this.namespace = target.authority || 'default'
    const hostPort = splitHostPort(target.path)
    this.serviceName = hostPort.host
    this.port = hostPort.port

    if (!this.serviceName || !this.port) {
      this.error = {
        code: Status.UNAVAILABLE,
        details: `Failed to parse ${target.scheme} address ${target.path} ${target.authority}`,
        metadata: new Metadata(),
      }
      return
    }

    this.defaultResolutionError = {
      code: Status.UNAVAILABLE,
      details: `Name resolution failed for target ${uriToString(this.target)}`,
      metadata: new Metadata(),
    }

    this.watch()
    this.timer = setInterval(() => this.updateResolution(), defaultRefreshFreq)
  }

  updateResolution() {
    trace('Resolution update requested for target ' + uriToString(this.target))
    setImmediate(() => {
      if (this.error) {
        this.listener.onError(this.error)
      } else {
        this._updateResolution()
      }
    })
  }

  destroy() {
    trace('Resolver destroy target ' + uriToString(this.target))

    if (this.informer) {
      this.informer.stop()
    }

    if (this.timer) {
      clearInterval(this.timer)
    }
  }

  private watch() {
    const informer = k8s.makeInformer(
      kc,
      `/api/v1/namespaces/${this.namespace}/endpoints?fieldSelector=${fieldSelectorPrefix}${this.serviceName}`,
      () =>
        k8sApi.listNamespacedEndpoints(
          this.namespace,
          undefined,
          undefined,
          undefined,
          `${fieldSelectorPrefix}${this.serviceName}`
        )
    )

    informer.on('add', (obj) => {
      let changed = false
      for (const sub of obj.subsets) {
        for (const point of sub.addresses) {
          if (!this.addresses.has(point.ip)) {
            this.addresses.add(point.ip)
            changed = true
          }
        }
      }

      if (changed) {
        this.updateResolutionFromAddress()
      }
    })

    informer.on('delete', (obj) => {
      let changed = false
      for (const sub of obj.subsets) {
        for (const point of sub.addresses) {
          if (!this.addresses.has(point.ip)) {
            this.addresses.delete(point.ip)
            changed = true
          }
        }
      }

      if (changed) {
        this.updateResolutionFromAddress()
      }
    })

    informer.on('update', (obj) => {
      const newAddressesSet = new Set<string>()
      for (const sub of obj.subsets) {
        for (const point of sub.addresses) {
          if (!newAddressesSet.has(point.ip)) {
            newAddressesSet.add(point.ip)
          }
        }
      }

      this.addresses = newAddressesSet
      this.updateResolutionFromAddress()
    })

    this.informer = informer

    return this.informer.start()
  }

  private async _updateResolution() {
    if (this.processing) {
      return
    }
    this.processing = true

    try {
      const res = await k8sApi.listNamespacedEndpoints(
        this.namespace,
        undefined,
        undefined,
        undefined,
        `${fieldSelectorPrefix}${this.serviceName}`
      )
      const subsets = res.body?.items?.[0]?.subsets
      const newAddressesSet = new Set<string>()
      for (const sub of subsets) {
        for (const point of sub.addresses) {
          if (!newAddressesSet.has(point.ip)) {
            newAddressesSet.add(point.ip)
          }
        }
      }

      this.addresses = newAddressesSet
      this.updateResolutionFromAddress()
    } catch (err) {
      trace(
        'Resolution error for target ' +
          uriToString(this.target) +
          ': ' +
          (err as Error).message
      )
      this.listener.onError(this.defaultResolutionError)
    } finally {
      this.processing = false
    }
  }

  private updateResolutionFromAddress() {
    if (this.addresses.size === 0) {
      return
    }

    trace(
      `Resolver update listener, target ${uriToString(
        this.target
      )}, address: ${[...this.addresses]}`
    )

    this.listener.onSuccessfulResolution(
      this.addressToSubchannelAddress(),
      null,
      null,
      null,
      {}
    )
  }

  private addressToSubchannelAddress(): SubchannelAddress[] {
    const res: SubchannelAddress[] = []
    for (const addr of this.addresses) {
      res.push({
        host: addr,
        port: this.port,
      })
    }

    return res
  }

  static getDefaultAuthority(target: GrpcUri): string {
    return target.path
  }
}

export const setup = () => {
  registerResolver(K8sScheme, K8sResolover)
}
