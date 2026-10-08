# next.test for the path-mount e2e stack: a real Next.js production server (`next build` +
# `next start`) running the documented rewrites recipe. Exact versions in package.json and a
# committed lockfile; built at `up --build` time, never pushed.
FROM node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
WORKDIR /srv/next
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY next.config.mjs proxy.js ./
COPY app ./app
RUN npm run build
USER node
EXPOSE 3000
CMD ["npm", "start"]
