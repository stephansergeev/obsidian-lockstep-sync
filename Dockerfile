# SPDX-License-Identifier: MIT

FROM golang:1.24-alpine AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /sync-server ./cmd/sync-server

# Nothing but the binary. There is no base image to patch, no shell to exploit and
# no package manager to keep up with, because a static Go binary needs none of them.
FROM scratch
COPY --from=build /sync-server /sync-server

# There is deliberately no VOLUME line here. Declaring one makes Docker invent an
# anonymous volume whenever somebody forgets to mount anything, and that volume is
# what "docker compose down -v" quietly destroys. Mount a directory you can see.
EXPOSE 8080
ENTRYPOINT ["/sync-server"]
CMD ["serve", "--data", "/data", "--addr", "0.0.0.0:8080"]
