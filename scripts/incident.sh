#!/bin/sh
# Tire une panne au hasard parmi 5 et n'affiche rien.
# A lancer SUR la machine cible, sans regarder le resultat :
#   ssh -i deploy_key -p 2222 root@localhost 'sh -s' < scripts/incident.sh
# Le debriefing se fait avec : base64 -d /root/.incident

N=$(( $(od -An -N1 -tu1 /dev/urandom) % 5 + 1 ))
echo "$N" | base64 > /root/.incident

IMAGE=$(docker inspect -f '{{.Config.Image}}' todo-api)

case "$N" in
  1) docker stop todo-api ;;
  2) docker stop todo-db ;;
  3) NET=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' todo-api | awk '{print $1}')
     docker network disconnect "$NET" todo-api ;;
  4) docker rm -f todo-api
     docker run -d --name todo-api -p 3000:3000 "$IMAGE" ;;
  5) for i in 1 2 3 4; do
       docker rm -f "hog-$i" 2>/dev/null
       docker run -d --name "hog-$i" alpine sh -c 'while :; do :; done'
     done ;;
esac
