FROM node:24-alpine
LABEL org.opencontainers.image.title="8star Stream" org.opencontainers.image.version="0.1.0"
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data TZ=Europe/Amsterdam
RUN apk add --no-cache tzdata
COPY package.json package-lock.json ./
COPY scripts ./scripts
COPY public ./public
# postinstall copies hls.js into public/vendor (served by the app itself).
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js ./
COPY src ./src
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown -R app:app /data
USER app
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
