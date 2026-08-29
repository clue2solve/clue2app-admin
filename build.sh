#!/bin/bash
set -e

echo "Building Clue2App Admin (aws-dashboard)..."
echo ""
echo "This repo no longer uses a Dockerfile. Choose a build path:"
echo ""
echo "  1) Native local run (fastest for iteration):"
echo "       cd backend && python3 -m venv .venv && source .venv/bin/activate"
echo "       pip install -r requirements.txt"
echo "       cd .. && ./build.sh --frontend"
echo "       cd backend && python main.py"
echo ""
echo "  2) Build a container image via Paketo buildpacks (same as the platform's kpack):"
echo "       ./build.sh --frontend"
echo "       pack build aws-dashboard:latest \\"
echo "           --builder paketobuildpacks/builder-jammy-base --path ./backend"
echo ""
echo "  3) Deploy to Clue2App directly (no local build):"
echo "       c2a deploy --repo clue2solve/clue2app-admin --branch main"
echo ""

# Optional --frontend flag builds the React frontend into backend/static
if [ "$1" = "--frontend" ]; then
    echo "Building frontend..."
    cd frontend
    npm ci
    npm run build
    cd ..

    echo "Copying frontend to backend/static..."
    rm -rf backend/static
    cp -r frontend/dist backend/static
    echo "Frontend build complete."
fi
