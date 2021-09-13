# grpc-resolver-k8s example

## 0. create namespace

```bash
kubectl create ns grpc-test
```

## 1. setup service account

```bash
kubectl apply -f ./k8s/account.yaml
```

## 2. deploy server and client

```bash
kubectl apply -f ./k8s/service.yaml
kubectl apply -f ./k8s/client.yaml
```

## 3. test resolver

tweak `./k8s/service.yaml` replicas num to test resolver

```bash
# apply change after edit ./k8s/service.yaml
kubectl apply -f ./k8s/service.yaml
```

## 4. clean up

```bash
kubectl delete ns grpc-test
```
