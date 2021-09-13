# grpc-resolver-k8s

[![NPM version](https://img.shields.io/npm/v/@zcong/grpc-resolver-k8s.svg?style=flat)](https://npmjs.com/package/@zcong/grpc-resolver-k8s)
[![NPM downloads](https://img.shields.io/npm/dm/@zcong/grpc-resolver-k8s.svg?style=flat)](https://npmjs.com/package/@zcong/grpc-resolver-k8s)

<!-- [![codecov](https://codecov.io/gh/zcong1993/grpc-resolver-k8s/branch/master/graph/badge.svg)](https://codecov.io/gh/zcong1993/grpc-resolver-k8s) -->

> k8s resolver for @grpc/grpc-js

## Install

```bash
$ yarn add @zcong/grpc-resolver-k8s
# or npm
$ npm i @zcong/grpc-resolver-k8s --save
```

## Usage

Make sure the client pod service account have enough permissions to access k8s resource endpoints. Can see [account.yaml](./example/k8s/account.yaml).

### client

```ts
import { K8sScheme, setup } from '@zcong/grpc-resolver-k8s'

setup()

const serviceName = process.env.SERVICE_NAME || 'test-grpc-server'
const servicePort = process.env.SERVICE_PORT || '8080'
const serviceNs = process.env.SERVICE_NS || 'default'

const main = async () => {
  const c = new HelloClient(
    `${K8sScheme}://${serviceNs}/${serviceName}:${servicePort}`, // use service name with K8sScheme
    grpc.credentials.createInsecure(),
    { 'grpc.service_config': '{"loadBalancingConfig": [{"round_robin": {}}]}' } // don't forget use round_robin lb, default is pick first
  )
}
```

For more details, please check [example](./example).

## License

MIT &copy; zcong1993
