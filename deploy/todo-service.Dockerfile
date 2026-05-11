FROM --platform=linux/amd64 public.ecr.aws/docker/library/golang:1.24-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
ENV GOTOOLCHAIN=auto
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /server ./cmd/todo-service

# grpcurl is baked in so the verification scripts can run via ECS Exec to sample
# x-service-revision trailers from real Service Connect traffic during a LINEAR rollout.
FROM --platform=linux/amd64 public.ecr.aws/docker/library/golang:1.24-alpine AS grpcurl
RUN apk add --no-cache git \
    && go install github.com/fullstorydev/grpcurl/cmd/grpcurl@v1.9.1

FROM --platform=linux/amd64 public.ecr.aws/docker/library/alpine:3.20
RUN apk add --no-cache ca-certificates
RUN wget -qO /etc/ssl/certs/global-bundle.pem \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
COPY --from=builder /server /server
COPY --from=grpcurl /go/bin/grpcurl /usr/local/bin/grpcurl
ENV DOCUMENTDB_CA_FILE=/etc/ssl/certs/global-bundle.pem
EXPOSE 8080 50051
ENTRYPOINT ["/server"]
