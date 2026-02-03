#!/bin/bash
# Setup script for DGX deployment
# Run this on the DGX machine

set -e

DOMAIN="multiagent.duckdns.org"
EMAIL="${1:-admin@example.com}"

echo "=========================================="
echo "  Multi-Agents DGX Setup"
echo "  Domain: $DOMAIN"
echo "=========================================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run as root (sudo ./setup-dgx.sh your@email.com)"
    exit 1
fi

# 1. Install Docker if not present
if ! command -v docker &> /dev/null; then
    echo "[1/5] Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
else
    echo "[1/5] Docker already installed"
fi

# 2. Install Docker Compose if not present
if ! command -v docker-compose &> /dev/null; then
    echo "[2/5] Installing Docker Compose..."
    curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
else
    echo "[2/5] Docker Compose already installed"
fi

# 3. Create directories
echo "[3/5] Creating directories..."
mkdir -p certbot/conf certbot/www

# 4. Get initial certificate
echo "[4/5] Obtaining Let's Encrypt certificate..."

# Start nginx temporarily for ACME challenge
docker run -d --name temp-nginx \
    -p 80:80 \
    -v $(pwd)/certbot/www:/var/www/certbot \
    nginx:alpine \
    sh -c "echo 'server { listen 80; location /.well-known/acme-challenge/ { root /var/www/certbot; } }' > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"

sleep 3

# Get certificate
docker run --rm \
    -v $(pwd)/certbot/conf:/etc/letsencrypt \
    -v $(pwd)/certbot/www:/var/www/certbot \
    certbot/certbot certonly \
    --webroot \
    --webroot-path=/var/www/certbot \
    --email $EMAIL \
    --agree-tos \
    --no-eff-email \
    -d $DOMAIN

# Stop temp nginx
docker stop temp-nginx && docker rm temp-nginx

# 5. Create .env file
echo "[5/5] Creating .env file..."
if [ ! -f .env ]; then
    cat > .env << EOF
# API Keys
ANTHROPIC_API_KEY=your-api-key-here

# Domain
DOMAIN=$DOMAIN

# Frontend path (relative to deploy folder)
FRONTEND_PATH=../../multi-agent-frontend
EOF
    echo "Created .env file - EDIT IT with your ANTHROPIC_API_KEY!"
else
    echo ".env already exists"
fi

# 6. Clone frontend if not exists
echo "[6/6] Cloning frontend..."
if [ ! -d "../../mult-agents-frontend" ]; then
    git clone https://github.com/devwspito/mult-agents-frontend.git ../../mult-agents-frontend
    echo "Frontend cloned"
else
    echo "Frontend already exists, pulling latest..."
    cd ../../mult-agents-frontend && git pull && cd -
fi

echo ""
echo "=========================================="
echo "  Setup Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "  1. Edit .env and add your ANTHROPIC_API_KEY"
echo "  2. Run: docker-compose up -d"
echo ""
echo "Your app will be available at: https://$DOMAIN"
