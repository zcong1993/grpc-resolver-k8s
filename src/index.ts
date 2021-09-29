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

const defaultRefreshFreq = 1000 * 60 * 5 // 5min force refetch full enpoint peers interval
const TRACER_NAME = 'k8s_resolver'

const trace = (text: string) => {
  logging.trace(LogVerbosity.DEBUG, TRACER_NAME, text)
}

export const K8sScheme = 'k8s'

const fieldSelectorPrefix = 'metadata.name='

const kc = new k8s.KubeConfig()
kc.loadFromDefault()
let k8sApi: k8s.CoreV1Api

export const setup = () => {
  // init k8s client in setup avoid throw error
  // when only import lib in non k8s env
  k8sApi = kc.makeApiClient(k8s.CoreV1Api)
  registerResolver(K8sScheme, K8sResolover)
}

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
    this.trace('Resolver constructed')
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
    this.trace('Resolution update requested')
    setImmediate(() => {
      if (this.error) {
        this.listener.onError(this.error)
      } else {
        this._updateResolution()
      }
    })
  }

  destroy() {
    this.trace('Resolver destroy')

    if (this.informer) {
      this.informer.stop()
    }

    if (this.timer) {
      clearInterval(this.timer)
    }
  }

  private watch() {
    // watch endpoints by namespace and service name
    const informer = k8s.makeInformer(
      kc,
      `/api/v1/namespaces/${this.namespace}/endpoints?fieldSelector=${fieldSelectorPrefix}${this.serviceName}`, // makeInformer not support fieldSelector as params for now
      () => this.fetchEndpoints()
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

      this.trace(
        `informer add event, changed: ${changed}, obj: ${JSON.stringify(obj)}`
      )
    })

    informer.on('delete', (obj) => {
      let changed = false
      for (const sub of obj.subsets) {
        for (const point of sub.addresses) {
          if (this.addresses.has(point.ip)) {
            this.addresses.delete(point.ip)
            changed = true
          }
        }
      }

      if (changed) {
        this.updateResolutionFromAddress()
      }

      this.trace(
        `informer delete event, changed: ${changed}, obj: ${JSON.stringify(
          obj
        )}`
      )
    })

    informer.on('update', (obj) => {
      this.handleFullUpdate(obj.subsets)

      this.trace(`informer update event, obj: ${JSON.stringify(obj)}`)
    })

    // informer will not restart when the under watcher got error
    // so we restart the informer ourselves
    informer.on('error', (err: any) => {
      this.trace(
        `informer error event, will restart informer, err: ${JSON.stringify(
          err
        )}`
      )
      // todo: if need a backoff
      setTimeout(() => informer.start(), 1000)
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
      const res = await this.fetchEndpoints()
      // only watch for a certain namespace and a certain service name
      // so items.length must <= 1
      const item = res.body?.items?.[0]
      if (!item) {
        // no endpoints here, report error
        this.listener.onError(this.defaultResolutionError)
        return
      }
      this.handleFullUpdate(item.subsets)
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

    this.trace(`Resolver update listener, address: ${[...this.addresses]}`)

    this.listener.onSuccessfulResolution(
      this.addressToSubchannelAddress(),
      null,
      null,
      null,
      {}
    )
  }

  private addressToSubchannelAddress(): SubchannelAddress[] {
    return [...this.addresses.keys()].map((addr) => ({
      host: addr,
      port: this.port,
    }))
  }

  private async fetchEndpoints() {
    return k8sApi.listNamespacedEndpoints(
      this.namespace,
      undefined,
      undefined,
      undefined,
      `${fieldSelectorPrefix}${this.serviceName}`
    )
  }

  private handleFullUpdate(subsets: k8s.V1EndpointSubset[]) {
    const newAddressesSet = new Set<string>()
    for (const sub of subsets) {
      for (const point of sub.addresses) {
        if (!newAddressesSet.has(point.ip)) {
          newAddressesSet.add(point.ip)
        }
      }
    }

    // diff set
    let changed = false
    if (this.addresses.size !== newAddressesSet.size) {
      changed = true
    } else {
      for (const newAddr of newAddressesSet) {
        if (!this.addresses.has(newAddr)) {
          changed = true
          break
        }
      }
    }

    if (changed) {
      this.addresses = newAddressesSet
      this.updateResolutionFromAddress()
    }

    this.trace(`HandleFullUpdate changed: ${changed}`)
  }

  private trace(msg: string) {
    trace(`Target ${uriToString(this.target)} ${msg}`)
  }

  static getDefaultAuthority(target: GrpcUri): string {
    return target.path
  }
}
