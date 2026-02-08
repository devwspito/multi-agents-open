#!/bin/bash
#
# Open Multi-Agents - Stop Script
#
# Para todos los servicios
#

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo -e "${YELLOW}Parando servicios...${NC}"

# Parar Docker Compose
if docker compose ps -q &>/dev/null; then
    docker compose down
    echo -e "${GREEN}✓ PostgreSQL y Redis parados${NC}"
else
    echo "Docker Compose no está corriendo"
fi

# Matar procesos de Node si están corriendo
pkill -f "tsx watch src/server.ts" 2>/dev/null || true
pkill -f "opencode-ai serve" 2>/dev/null || true

echo -e "${GREEN}✓ Todos los servicios parados${NC}"
