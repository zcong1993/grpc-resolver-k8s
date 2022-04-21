FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache curl \
    vim \
    ca-certificates \
    busybox-extras \
    tini

RUN npm i -g pnpm@latest

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm example

ENTRYPOINT [ "/sbin/tini", "--" ]
