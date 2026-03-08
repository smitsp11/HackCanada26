#!/bin/bash
# Helper script to activate virtual environment and run FastAPI backend

# Activate virtual environment
source "$(dirname "$0")/venv/bin/activate"

# Run the server
uvicorn main:app --host 0.0.0.0 --port 8000
