#!/bin/bash
#
# Open Multi-Agents - Full Startup Script
#
# Levanta todo el stack:
# 1. Docker Compose (PostgreSQL + Redis)
# 2. OpenCode SDK
# 3. Backend Server
#
# Uso:
#   ./scripts/start.sh        # Modo desarrollo
#   ./scripts/start.sh prod   # Modo producción
#

set -e

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Directorio del proyecto
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo -e "${BLUE}"
echo "============================================================"
echo " Open Multi-Agents - Full Stack Startup"
echo "============================================================"
echo -e "${NC}"

# ============================================================
# 1. VERIFICAR DEPENDENCIAS
# ============================================================
echo -e "${YELLOW}[1/4] Verificando dependencias...${NC}"

# Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker no está instalado${NC}"
    echo "Instala Docker Desktop: https://www.docker.com/products/docker-desktop"
    exit 1
fi

# Docker Compose
if ! docker compose version &> /dev/null; then
    echo -e "${RED}Error: Docker Compose no está disponible${NC}"
    exit 1
fi

# Node
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js no está instalado${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Docker, Docker Compose y Node.js disponibles${NC}"

# ============================================================
# 2. VERIFICAR .env
# ============================================================
if [ ! -f ".env" ]; then
    echo -e "${RED}Error: .env no encontrado${NC}"
    echo "Copia .env.example a .env y configura tus credenciales"
    exit 1
fi

echo -e "${GREEN}✓ Archivo .env encontrado${NC}"

# ============================================================
# 3. LEVANTAR DOCKER COMPOSE (PostgreSQL + Redis)
# ============================================================
echo ""
echo -e "${YELLOW}[2/4] Levantando PostgreSQL + Redis...${NC}"

# Verificar si ya están corriendo
POSTGRES_RUNNING=$(docker compose ps -q postgres 2>/dev/null || true)
REDIS_RUNNING=$(docker compose ps -q redis 2>/dev/null || true)

if [ -n "$POSTGRES_RUNNING" ] && [ -n "$REDIS_RUNNING" ]; then
    echo -e "${GREEN}✓ PostgreSQL y Redis ya están corriendo${NC}"
else
    # Levantar contenedores
    docker compose up -d postgres redis

    # Esperar a que estén healthy
    echo "Esperando a que PostgreSQL esté listo..."
    RETRIES=30
    until docker compose exec -T postgres pg_isready -U oma -d open_multi_agents &>/dev/null || [ $RETRIES -eq 0 ]; do
        echo -n "."
        sleep 1
        RETRIES=$((RETRIES-1))
    done
    echo ""

    if [ $RETRIES -eq 0 ]; then
        echo -e "${RED}Error: PostgreSQL no arrancó a tiempo${NC}"
        docker compose logs postgres
        exit 1
    fi

    echo "Esperando a que Redis esté listo..."
    RETRIES=15
    until docker compose exec -T redis redis-cli ping &>/dev/null || [ $RETRIES -eq 0 ]; do
        echo -n "."
        sleep 1
        RETRIES=$((RETRIES-1))
    done
    echo ""

    if [ $RETRIES -eq 0 ]; then
        echo -e "${RED}Error: Redis no arrancó a tiempo${NC}"
        docker compose logs redis
        exit 1
    fi

    echo -e "${GREEN}✓ PostgreSQL y Redis listos${NC}"
fi

# ============================================================
# 4. INSTALAR DEPENDENCIAS SI ES NECESARIO
# ============================================================
echo ""
echo -e "${YELLOW}[3/4] Verificando node_modules...${NC}"

if [ ! -d "node_modules" ]; then
    echo "Instalando dependencias..."
    npm install
fi

echo -e "${GREEN}✓ Dependencias instaladas${NC}"

# ============================================================
# 5. LEVANTAR OPENCODE + BACKEND
# ============================================================
echo ""
echo -e "${YELLOW}[4/4] Levantando OpenCode + Backend...${NC}"
echo ""

MODE=${1:-dev}

if [ "$MODE" == "prod" ]; then
    echo -e "${BLUE}Modo: PRODUCCIÓN${NC}"
    echo "Compilando TypeScript..."
    npm run build
    echo ""
    echo -e "${GREEN}============================================================${NC}"
    echo -e "${GREEN} Stack completo iniciado en modo PRODUCCIÓN${NC}"
    echo -e "${GREEN}============================================================${NC}"
    echo ""
    npm run start
else
    echo -e "${BLUE}Modo: DESARROLLO${NC}"
    echo ""
    echo -e "${GREEN}============================================================${NC}"
    echo -e "${GREEN} Stack completo iniciado en modo DESARROLLO${NC}"
    echo -e "${GREEN}============================================================${NC}"
    echo ""
    echo "Servicios:"
    echo "  - PostgreSQL: localhost:5432"
    echo "  - Redis:      localhost:6379"
    echo "  - Backend:    http://localhost:3001"
    echo "  - OpenCode:   http://localhost:4096"
    echo ""
    echo "Para ver logs de Docker: docker compose logs -f"
    echo "Para parar todo: ./scripts/stop.sh"
    echo ""
    npm run dev
fi
