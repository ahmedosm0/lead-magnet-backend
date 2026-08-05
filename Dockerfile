FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# Docker's build stage runs as root, unlike Render's native Node build
# environment — that's the whole reason this moved to Docker. --with-deps
# needs apt-get as root to install chromium's shared libraries (libnss3,
# libatk, etc.); Render's native builder has no sudo, which is why the
# native build failed with "su: Authentication failure".
RUN npx playwright-core install --with-deps chromium

COPY . .

ENV PORT=4000
EXPOSE 4000

CMD ["node", "--env-file-if-exists=.env", "--experimental-strip-types", "main.ts"]
