#!/bin/sh
# Interroge /metrics de chaque pod todo-api en direct, sans passer par le Service.
# Usage : ./scripts/compteurs-par-pod.sh

for pod in $(kubectl get pods -n todo -l app=todo-api -o name); do
  kubectl port-forward -n todo "$pod" 3001:3000 >/dev/null 2>&1 &
  PF_PID=$!
  sleep 2
  echo "== $pod =="
  curl -s localhost:3001/metrics | grep '^http_requests_total' || echo "  (aucune requete comptee)"
  kill "$PF_PID" 2>/dev/null
  wait "$PF_PID" 2>/dev/null
done
