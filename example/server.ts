import * as grpc from '@grpc/grpc-js'
import { IHelloServer, HelloService } from './generated/hello_grpc_pb'

const helloServer: IHelloServer = {
  echo: (call, cb) => {
    console.log('req: ', call.request)
    cb(null, call.request)
  },
}

const main = async () => {
  const server = new grpc.Server()
  server.addService(HelloService, helloServer)

  server.bindAsync(
    '0.0.0.0:8080',
    grpc.ServerCredentials.createInsecure(),
    () => {
      server.start()
    }
  )
}

main()
