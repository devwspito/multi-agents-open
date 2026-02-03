#!/bin/bash
# Generate self-signed SSL certificates for local development

DOMAIN=${1:-"dgx.local"}
DAYS=365

echo "Generating self-signed SSL certificates for: $DOMAIN"

# Generate private key and certificate
openssl req -x509 -nodes -days $DAYS -newkey rsa:2048 \
  -keyout server.key \
  -out server.crt \
  -subj "/C=US/ST=Local/L=Local/O=MultiAgents/CN=$DOMAIN" \
  -addext "subjectAltName=DNS:$DOMAIN,DNS:localhost,IP:127.0.0.1"

# Set permissions
chmod 600 server.key
chmod 644 server.crt

echo "Certificates generated:"
echo "  - server.crt (certificate)"
echo "  - server.key (private key)"
echo ""
echo "To trust on macOS: sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain server.crt"
echo "To trust on Linux: sudo cp server.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates"
