import * as grpc from '@grpc/grpc-js'
import { HelloClient } from './generated/hello_grpc_pb'
import { EchoRequest } from './generated/hello_pb'
import { K8sScheme, setup } from '../src'

setup()

grpc.setLogVerbosity(grpc.logVerbosity.DEBUG)

const serviceName = process.env.SERVICE_NAME || 'test-grpc-server'
const servicePort = process.env.SERVICE_PORT || '8080'
const serviceNs = process.env.SERVICE_NS || 'default'

const local = process.env.LOCAL

let uri = `${K8sScheme}://${serviceNs}/${serviceName}:${servicePort}`

if (local) {
  uri = 'localhost:8080'
}

const main = async () => {
  const c = new HelloClient(
    uri,
    grpc.credentials.createInsecure(),
    { 'grpc.service_config': '{"loadBalancingConfig": [{"round_robin": {}}]}' } // use round_robin lb
  )
  setInterval(() => {
    const req = new EchoRequest()
    req.setMessage(`test-${new Date()}`)
    c.echo(req, (err, res) => {
      if (err) {
        console.log('error: ', err)
      } else {
        console.log('resp: ', res)
      }
    })
  }, 1000)
}

main()
