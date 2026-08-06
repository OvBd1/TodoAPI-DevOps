#!/bin/sh
# chaos.sh : tire une panne au hasard parmi cinq, sur todo-cluster, et n'affiche rien.
# A lancer depuis son poste, kubectl doit deja pointer sur todo-cluster.
# Le debriefing se fait avec : base64 -d .incident

N=$(( $(od -An -N1 -tu1 /dev/urandom) % 5 + 1 ))
echo "$N" | base64 > .incident

POD=$(kubectl get pods -n todo -l app=todo-api -o jsonpath='{.items[0].metadata.name}')
IMAGE=$(kubectl get deployment todo-api -n todo -o jsonpath='{.spec.template.spec.containers[0].image}')
REPO="${IMAGE%%:*}"

case "$N" in
  1) kubectl delete pod -n todo "$POD" ;;
  2) kubectl exec -n todo "$POD" -- kill 1 ;;
  3) kubectl set image deployment/todo-api todo-api="${REPO}:ce-tag-n-existe-pas" -n todo ;;
  4) kubectl patch secret todo-secret -n todo --type=json \
       -p='[{"op":"remove","path":"/data/DB_PASSWORD"}]'
     kubectl rollout restart deployment/todo-api -n todo ;;
  5) kubectl patch deployment todo-api -n todo --type=json \
       -p='[{"op":"add","path":"/spec/template/spec/containers/0/resources","value":{"limits":{"memory":"8Mi"}}}]' ;;
esac >/dev/null 2>&1
