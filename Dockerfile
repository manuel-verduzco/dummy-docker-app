FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Copy manifests first so the dependency layer is cached until they change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY app.js ./

# The official node image ships a non-root "node" user.
USER node

EXPOSE 3000

# /health doesn't touch Redis or the counter. Alpine has no curl, so use node.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app.js"]
