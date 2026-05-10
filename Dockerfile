FROM node:20-alpine

ENV NODE_ENV=production
EXPOSE 8080/tcp

LABEL maintainer="Mercury Workshop"
LABEL summary="Scramjet Demo Image"
LABEL description="Example application of Scramjet"

WORKDIR /app

COPY ["package.json", "pnpm-lock.yaml", "./"]
RUN apk add --upgrade --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate && pnpm install --prod --frozen-lockfile

COPY . .

ENTRYPOINT [ "node" ]
CMD ["src/index.js"]
