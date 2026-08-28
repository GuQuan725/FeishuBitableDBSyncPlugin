FROM node:20-bookworm-slim

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile=false
COPY tsconfig.json .env.example ./
COPY src ./src
COPY public ./public
RUN pnpm exec tsc -p tsconfig.json

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 8787
CMD ["node", "dist/src/index.js"]
