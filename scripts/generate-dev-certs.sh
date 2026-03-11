#!/usr/bin/env bash
# =============================================================================
# generate-dev-certs.sh — Self-signed CA + server/client certs for local dev
# =============================================================================
# Generates a development CA and server/client certificate pairs for:
#   - Kafka (mTLS between workers and broker)
#   - Redis (TLS connections from workers to Redis)
#
# Output: certs/ directory with CA cert, server cert/key, client cert/key
#
# Usage:
#   ./scripts/generate-dev-certs.sh
#   ./scripts/generate-dev-certs.sh --force   # Regenerate even if certs exist
# =============================================================================

set -euo pipefail

CERT_DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
FORCE=${1:-""}
DAYS=365

if [[ -f "$CERT_DIR/ca.crt" && "$FORCE" != "--force" ]]; then
  echo "Certificates already exist in $CERT_DIR. Use --force to regenerate."
  exit 0
fi

mkdir -p "$CERT_DIR"
cd "$CERT_DIR"

echo "Generating self-signed CA..."
openssl req -new -x509 -days $DAYS -nodes \
  -keyout ca.key -out ca.crt \
  -subj "/CN=Kaiban Dev CA/O=KaibanDistributed/C=US" \
  2>/dev/null

echo "Generating server certificate..."
openssl req -new -nodes \
  -keyout server.key -out server.csr \
  -subj "/CN=localhost/O=KaibanDistributed/C=US" \
  2>/dev/null

cat > server-ext.cnf <<EOF
[v3_req]
subjectAltName = @alt_names
[alt_names]
DNS.1 = localhost
DNS.2 = redis
DNS.3 = kafka
DNS.4 = zookeeper
DNS.5 = kaiban-worker
IP.1 = 127.0.0.1
EOF

openssl x509 -req -days $DAYS \
  -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -extfile server-ext.cnf -extensions v3_req \
  2>/dev/null

echo "Generating client certificate..."
openssl req -new -nodes \
  -keyout client.key -out client.csr \
  -subj "/CN=kaiban-worker/O=KaibanDistributed/C=US" \
  2>/dev/null

openssl x509 -req -days $DAYS \
  -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out client.crt \
  2>/dev/null

# Cleanup CSR files
rm -f *.csr *.cnf *.srl

echo ""
echo "Certificates generated in $CERT_DIR:"
ls -la "$CERT_DIR"
echo ""
echo "Files:"
echo "  ca.crt / ca.key       — Certificate Authority"
echo "  server.crt / server.key — Server (Kafka, Redis)"
echo "  client.crt / client.key — Client (Workers)"
echo ""
echo "For staging: use these self-signed certs."
echo "For production: replace with real CA-signed certificates via CI/CD secrets."
