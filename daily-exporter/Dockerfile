FROM alpine:3.20

RUN apk add --no-cache bash coreutils curl git jq tzdata ca-certificates

WORKDIR /app
COPY entrypoint.sh export-and-push.sh /app/
RUN chmod +x /app/entrypoint.sh /app/export-and-push.sh

ENTRYPOINT ["/app/entrypoint.sh"]
