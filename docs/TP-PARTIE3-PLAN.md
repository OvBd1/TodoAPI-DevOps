# TP Partie 3 — Déploiement automatisé, monitoring et procédure

> Note de travail personnelle (pas un livrable du TP).
> Source : `~/Documents/ClickFast/docs/partie3_gitlab_ci_monitoring_procedure.pdf`
> **Tout le travail de la partie 3 se fait dans CE dépôt (`todo-api`), pas dans ClickFast.**

## L'idée générale

Partie 2 (sur ClickFast) : la pipeline savait tester, construire une image Docker et la pousser
sur Docker Hub. Mais l'image **dort** sur Docker Hub — aucune machine ne la fait tourner.

La partie 3 bouche deux trous :

1. La pipeline **déménage** de ClickFast (projet d'échauffement) vers la **Todo API** (ce dépôt).
2. La pipeline va jusqu'au bout : elle **installe et démarre** l'app sur une machine de
   production, puis on la **surveille**, et on écrit la **procédure** à suivre quand ça casse.

Objectif en une phrase :
*un `git push` sur `main`, et l'app part en prod toute seule. Une panne, et on la voit avant
l'utilisateur.*

---

## Palier 1 — une machine de prod, et une pipeline qui l'atteint

### Phase 1 — la pipeline déménage sur la Todo API

Recopier / adapter la pipeline d'hier. Trois jobs :

- job `test` : lance les tests existants sur `ubuntu-latest`
- job `build` : construit l'image de la Todo API, la pousse sur Docker Hub **taguée au sha du
  commit**, avec les secrets déjà connus
- une règle de déclenchement qui distingue branche de travail (*on vérifie*) et push sur `main`
  (*on publie*)

Vérifications :

- deux push successifs sur `main` → deux tags différents sur Docker Hub, jamais deux fois le même
- une branche de travail lance les tests sans rien publier
- si le secret Docker Hub est retiré, seul le job `build` échoue ; les tests restent verts

### Phase 2 — la machine cible (maquette)

Une vraie VM coûte de l'argent → on la simule avec un conteneur `docker:28-dind` (Docker dans
Docker) + un serveur SSH. Du point de vue de la pipeline c'est identique : une adresse, un port,
une clé, un utilisateur, un Docker à l'autre bout. L'important c'est **l'isolation** : son Docker
ne voit pas les conteneurs de mon poste.

**Sécurité d'abord** : la ligne `deploy_key` dans le `.gitignore` s'écrit **AVANT** le premier
`git add` de la phase.

```sh
# -N "" : pas de phrase de passe, la pipeline ne pourra pas en taper une
ssh-keygen -t ed25519 -N "" -f deploy_key
```

`Dockerfile.vm` :

```dockerfile
FROM docker:28-dind
# openssh-server : le programme qui écoute les connexions SSH entrantes
RUN apk add --no-cache openssh-server && ssh-keygen -A
RUN mkdir -p /root/.ssh && chmod 700 /root/.ssh
# La clé PUBLIQUE du déploiement, la seule qui aura le droit d'entrer
COPY deploy_key.pub /root/.ssh/authorized_keys
RUN chmod 600 /root/.ssh/authorized_keys
# sshd doit démarrer AVANT le daemon Docker, sinon il ne démarre jamais
RUN printf '#!/bin/sh\n/usr/sbin/sshd\nexec dockerd-entrypoint.sh "$@"\n' > /start.sh \
    && chmod +x /start.sh
ENTRYPOINT ["/start.sh"]
```

```sh
docker build -f Dockerfile.vm -t vm-prod .

# --privileged : nécessaire pour qu'un Docker tourne dans un conteneur.
# C'est aussi pour ça qu'on ne fait jamais ça sur une vraie prod.
docker run -d --privileged --name vm-prod \
  -p 2222:22 \
  -p 3000:3000 \
  -p 9090:9090 \
  -p 3001:3001 \
  -v vm-prod-data:/var/lib/docker \
  vm-prod

ssh -i deploy_key -p 2222 root@localhost
```

Le volume `vm-prod-data` garde images et conteneurs entre deux redémarrages.

Vérifications :

- la connexion SSH aboutit avec la clé, et `docker run --rm hello-world` marche à l'intérieur
- la même connexion **sans** `-i deploy_key` est refusée
- `docker restart vm-prod` + reconnexion → les images déjà téléchargées sont toujours là

### Phase 3 — le runner chez moi

Le runner hébergé par GitHub tourne dans un datacenter et ne peut pas joindre une machine
derrière ma box. Solution : enregistrer mon PC comme runner.

`Settings > Actions > Runners > New self-hosted runner` → `./config.sh` (jeton à usage unique)
puis `./run.sh`. **Le terminal qui exécute `./run.sh` doit rester ouvert tout l'après-midi**,
sinon les jobs restent "Queued".

Une seule ligne change dans le workflow — et seulement sur le job de déploiement :

```yaml
jobs:
  deploy:
    runs-on: self-hosted   # au lieu de ubuntu-latest : ce job tourne chez moi
```

Décision d'architecture : **chaque job choisit son runner.** Les tests n'ont besoin de rien de
local → ils restent sur `ubuntu-latest`. Seul le déploiement tourne chez moi.

⚠️ Dépôt public + runner self-hosted = n'importe qui peut proposer une PR avec du code hostile.
Le risque est nul tant que `deploy` ne se déclenche que sur un push vers `main`.

### Phase 4 — le job qui déploie

Deux fichiers vivent sur la machine cible, dans `/srv/todo` :

- `compose.yml` : la stack de prod (l'API + sa base)
- `.env` : les mots de passe. Copié **une fois à la main**, il ne sort jamais du dépôt et n'y
  rentre jamais.

`compose.yml` de prod — il ne **construit** plus l'image, il la **télécharge**, et la version
vient de l'extérieur :

```yaml
services:
  todo-api:
    container_name: todo-api      # nom fixe : la pipeline et les scripts comptent dessus
    image: VOTRE_PSEUDO/todo-api:${TAG}   # ${TAG} vient de l'environnement, pas du fichier
    # TODO : les variables d'environnement de connexion à la base, lues depuis .env
    # TODO : la publication du port 3000
    # TODO : depends_on, restart
  todo-db:
    container_name: todo-db
    image: postgres:16-alpine
    # TODO : les variables POSTGRES_*, et un volume nommé pour les données
```

Le déploiement devient une seule commande, jouée sur la machine cible :

```sh
cd /srv/todo && TAG=<le sha du commit> docker compose up -d
```

Squelette du job :

```yaml
deploy:
  needs: [build]          # rien ne se déploie avant que l'image existe
  runs-on: self-hosted    # ce job tourne chez moi, à côté de la machine cible
  if: github.ref == 'refs/heads/main'
  steps:
    - uses: actions/checkout@v4
    # TODO : charger $DEPLOY_SSH_KEY dans un agent SSH, sans l'écrire sur le disque
    # TODO : envoyer compose.yml sur la machine cible avec scp
    # TODO : lancer la commande de déploiement en SSH, avec le sha du commit comme TAG
    # TODO : vérifier avec curl que /health répond, et faire échouer le job sinon
```

Indice sur le 1er TODO : une clé privée écrite dans un fichier temporaire traîne sur le disque du
runner. La bonne méthode passe par l'**agent SSH** (garde la clé en mémoire le temps de la
session). L'action `webfactory/ssh-agent` fait ça en une ligne.

Secrets à créer dans `Settings > Secrets and variables > Actions` :
`DEPLOY_SSH_KEY` (contenu de `deploy_key`), `DEPLOY_HOST`, `DEPLOY_PORT`, `DEPLOY_USER`.

Vérifications :

- un push sur `main` déclenche la chaîne complète, l'API répond, aucune commande tapée à la main
- un push sur une branche construit et teste mais ne déploie rien
- un secret mal orthographié fait échouer le job à la connexion, avec un message clair, et **la
  clé n'apparaît nulle part dans le log** (relire le log ligne par ligne)

---

## Palier 2 — ce qui part est vérifié, ce qui tourne est visible

### Phase 5 — rejouer, et revenir en arrière

Se documente au fur et à mesure dans le **Journal de bord** (les temps mesurés servent de
référence toute la fin de journée).

1. Repousser exactement le même code → la pipeline repasse, rien ne casse.
   `docker compose up -d` compare l'état voulu à l'état réel (là où une séquence naïve de
   `docker run` aurait planté sur un nom de conteneur déjà pris) → **idempotence**.
2. Le retour arrière — chaque image porte le sha de son commit, donc ni build ni pipeline :

```sh
# La version précédente est déjà sur Docker Hub, il suffit de la nommer
cd /srv/todo && TAG=<sha précédent> docker compose up -d
```

Scénario complet à jouer : introduire volontairement une régression visible, la laisser partir en
prod, la constater, revenir à la version d'avant. **Chronomètre en main.**

Ce qui doit être vrai à la fin :

- deux déploiements identiques d'affilée → même état, aucun conteneur orphelin, aucun port occupé
- le retour arrière rétablit le service, et le Journal de bord note le temps constat → rétablissement
- un retour arrière vers un tag inexistant échoue **franchement**, message lisible, sans laisser
  la prod à moitié éteinte
- **noter la commande de retour arrière dès maintenant** : c'est la ligne la plus importante de la
  procédure de la phase 9

### Phase 6 — les tests qui touchent la base

La qualité des cas testés compte plus que leur nombre. Job sur `ubuntu-latest`, avec une base
jetable lancée en **conteneur de service** à côté.

Quatre comportements minimum :

- créer une tâche, la relire par son identifiant, retrouver exactement ce qui a été envoyé
- demander une tâche qui n'existe pas → `404` propre (pas une erreur serveur)
- envoyer un corps invalide (champ obligatoire manquant, description démesurée) → `400`
- supprimer une tâche, vérifier qu'elle a disparu de la liste

Le schéma de la base doit exister avant le 1er test : script SQL au démarrage, ou migration
lancée en amont dans le job.

Qu'est-ce qui casse si… :

- le job démarre avant que PostgreSQL soit prêt → échecs aléatoires. Parade : healthcheck sur le
  service, ou attente active.
- les tests tournent deux fois sans nettoyer → le 2e passage échoue. Chaque test repart d'un état
  connu.
- une assertion est retirée → le test passe et ne sert plus à rien. Vrai contrôle : casser
  volontairement une route et vérifier que la pipeline devient rouge.

### Phase 7 — rendre l'API mesurable

L'instrumentation touche le code applicatif → **commit séparé** d'une correction de route.

Avec `prom-client`, trois choses à produire :

- une route `/metrics` qui répond en **texte brut**, jamais en JSON
- un compteur des requêtes HTTP servies, découpé par méthode, route et code de statut
- un histogramme de la durée des requêtes (celui qui permet de calculer un p95)

Plus une 4e mesure **métier** (nb de tâches créées depuis le démarrage, ou nb de tâches en base) :
c'est la seule métrique que personne d'autre que moi ne peut deviner.

```
$ curl -s localhost:3000/metrics | head -5
# HELP http_requests_total Nombre total de requetes HTTP servies
# TYPE http_requests_total counter
http_requests_total{method="GET",route="/api/tasks",status="200"} 12
http_requests_total{method="POST",route="/api/tasks",status="201"} 3
```

Le test qui compte : appeler 3 fois la même route, recharger `/metrics`, le compteur a augmenté
de **3 exactement**.

Deux pièges :

- une route inconnue qui renvoie `404` doit être comptée aussi, sinon la moitié des erreurs
  devient invisible
- l'identifiant de tâche ne doit **jamais** devenir un label. Le label c'est `/api/tasks/:id`,
  pas `/api/tasks/8f2c-…` (sinon Prometheus s'étouffe au bout de quelques milliers de tâches)

### Phase 8 — Prometheus et Grafana sur la machine cible

`prometheus.yml` et la définition du dashboard sont **du code** : ils vivent dans le dépôt,
partent sur la machine cible par la pipeline, et ne se modifient jamais directement en prod.

La surveillance rejoint la stack de prod, dans le **même `compose.yml` et le même réseau** — c'est
ce qui permet à Prometheus de joindre l'API par son nom de service, sans exposer de port.

```yaml
# prometheus.yml
global:
  scrape_interval: 5s        # court, pour voir les effets pendant le cours
scrape_configs:
  - job_name: todo-api
    static_configs:
      - targets: ['todo-api:3000']   # le nom du service, pas une adresse IP
```

Grafana sur `http://localhost:3001`, source de données `http://prometheus:9090`.
⚠️ L'erreur qui fait perdre 15 min : saisir `localhost:9090` — depuis le conteneur Grafana ça
désigne Grafana lui-même, pas Prometheus.

Dashboard = les **4 golden signals**, un panneau chacun :

| Panneau | Requête |
|---|---|
| Disponibilité | `up` |
| Trafic | nombre de requêtes par seconde (`rate`) |
| Erreurs | part de réponses en 5xx |
| Latence | p95 du temps de réponse (`histogram_quantile`) |

Pour avoir autre chose qu'une ligne plate, générer de la charge :

```sh
# Un peu de charge, pendant deux minutes, depuis mon poste
while true; do
  curl -s localhost:3000/api/tasks > /dev/null
  curl -s -X POST localhost:3000/api/tasks \
    -H 'Content-Type: application/json' \
    -d '{"description":"charge","status":"todo"}' > /dev/null
  curl -s localhost:3000/api/tasks/inexistant > /dev/null   # pour peupler les erreurs
  sleep 0.2
done
```

**Relevé attendu dans le Journal de bord** — le tableau qui fait le lien entre toutes les phases :

| Moment | `up` | Requêtes/s | Taux d'erreur | p95 |
|---|---|---|---|---|
| Au repos, avant la boucle de charge | | | | |
| Pendant la boucle de charge | | | | |
| Pendant l'incident de la phase 10 | | | | |

Checkpoint qualité :

- `docker stop todo-api` sur la machine cible → `up` tombe à zéro en moins de 15 s, visible sans
  recharger la page
- un panneau vide alors que l'app tourne = source de données ou nom de métrique faux, jamais
  "Grafana bugge"
- couper la **base** sans couper l'**API** donne une signature différente : la cible répond
  toujours, mais les erreurs explosent. Savoir distinguer ces deux images = savoir diagnostiquer.

---

## Palier 3 — l'astreinte

### Phase 9 — la procédure de déploiement

Livrable au même titre que le code : `docs/PROCEDURE_DEPLOIEMENT.md`, commité comme le reste.
Le seul lecteur qui compte : le camarade qui l'ouvrira sans rien connaître du projet.

Contenu minimum :

- ce qu'il faut avoir sous la main avant de commencer : accès, clé, adresse et port de la machine
  cible, emplacement des fichiers
- les **étapes numérotées**, avec les commandes exactes, copiables telles quelles, sans deviner un
  chemin ou un nom
- **un point de vérification après chaque étape**, formulé comme un résultat observable
  ("la commande répond `ok`", "le panneau Disponibilité repasse à 1")
- la procédure de **retour arrière** : sa commande, le critère qui déclenche la décision, et qui
  la prend
- la **liste des pannes connues et leur signature dans le tableau de bord** — c'est ce qui
  transforme un document en outil de diagnostic
- la **durée attendue** d'un déploiement normal, pour savoir à partir de quand s'inquiéter

Trois façons de l'éprouver avant la passation :

- la relire en se demandant à chaque étape "un inconnu saurait-il taper ça sans me poser de
  question ?" et compter les non
- imaginer un cas non prévu (ex. port 3000 déjà occupé sur la machine cible) et voir si le
  document laisse le lecteur sans issue
- glisser volontairement une erreur dans une commande, et vérifier que le point de vérification de
  l'étape suivante la détecte

### Phase 10 — la passation

Un script tire **une panne au hasard parmi 5** et n'affiche rien. Le lire à l'avance ne donne
aucun avantage : toute la difficulté est de reconnaître **laquelle** se produit.

```sh
#!/bin/sh
# incident.sh : à lancer SUR la machine cible, sans regarder le résultat.
# ssh -i deploy_key -p 2222 root@localhost 'sh -s' < incident.sh
N=$(( $(od -An -N1 -tu1 /dev/urandom) % 5 + 1 ))
echo "$N" | base64 > /root/.incident   # la réponse, pour le débriefing seulement
IMAGE=$(docker inspect -f '{{.Config.Image}}' todo-api)
case "$N" in
  1) docker stop todo-api ;;                        # plus personne ne répond
  2) docker stop todo-db ;;                         # l'API répond, la base a disparu
  3) NET=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' todo-api | awk '{print $1}')
     docker network disconnect "$NET" todo-api ;;   # la base tourne, l'API ne la joint plus
  4) docker rm -f todo-api
     docker run -d --name todo-api -p 3000:3000 "$IMAGE" ;;  # relancée sans sa configuration
  5) for i in 1 2 3 4; do docker run -d --name hog-$i alpine sh -c 'while :; do :; done'; done ;;  # la machine ne respire plus
esac
```

Déroulé, en binôme, dernière heure :

- **Les mains** = la personne dont la machine est en panne. Elle tape, elle lit à voix haute, et
  elle **n'a pas le droit de diagnostiquer**, même sur son propre système.
- **Le pilote** = le camarade. Il n'a jamais vu cette machine. Il a seulement la **procédure
  écrite par l'autre** et le **dashboard Grafana**. Il diagnostique, il dicte, il décide.

1. chacun lance le script sur sa propre machine cible, sans regarder
2. le binôme se forme, le chrono démarre
3. le pilote ouvre la procédure + le dashboard et pose ses questions
4. service rétabli → chrono arrêté = **temps de rétablissement** (4e métrique DORA)
5. les rôles s'inversent

Débriefing : `base64 -d /root/.incident` donne la réponse. Trois questions :

- quel panneau a été le plus utile, lequel n'a rien apporté
- quelle ligne de la procédure a manqué, et comment elle s'écrit maintenant
- combien de temps entre le début de la panne et le rétablissement, et où est parti ce temps

Puis on corrige la procédure et on tire un second incident pour vérifier que la correction paye.

---

## Ce qui est rendu

Le dépôt Git de la Todo API (public ou avec accès donné) contient :

- [ ] le code de l'API, **instrumenté**, avec ses tests unitaires **et** ses tests d'intégration
- [ ] les workflows dans `.github/workflows/`, dont le job de déploiement
- [ ] le `Dockerfile.vm`, le `compose.yml` de production et le `prometheus.yml`
- [ ] la définition du tableau de bord Grafana, **exportée en JSON**
- [ ] `docs/PROCEDURE_DEPLOIEMENT.md`
- [ ] un `README.md` à jour, avec la section **Journal de bord** : le tableau de relevés de la
      phase 8, le retour arrière chronométré de la phase 5, et les **deux entrées de la passation**

**Ni la clé privée, ni le `.env`, ni aucun mot de passe dans le dépôt.** Un `git log -p` qui les
ferait apparaître, même supprimés depuis, compte comme une fuite.

## Grille d'évaluation

| Critère | Poids | Ce qui est regardé |
|---|---|---|
| Déploiement automatisé | 30 % | un push sur `main` déploie sans intervention, l'API répond, le job échoue proprement si elle ne répond pas |
| Surveillance | 20 % | `/metrics` exposé et pertinent, Prometheus qui collecte, 4 panneaux qui répondent aux 4 signaux |
| Procédure de déploiement | 20 % | complète, vérifications par étape, retour arrière, **validée par un tiers qui a réussi à s'en servir** |
| Tests d'intégration | 15 % | une vraie base en pipeline, cas succès / absence / entrée invalide |
| Journal de bord | 10 % | relevés chiffrés + deux entrées de la passation, y compris ce qui n'a pas marché |
| Rigueur du dépôt | 5 % | commits atomiques, aucun secret versionné, `.gitignore` à jour |

Bonus apprécié : un panneau inventé propre au métier, une alerte Grafana avec seuil justifié, un
retour arrière déclenché depuis la pipeline plutôt qu'à la main, une procédure qui a survécu à
deux incidents sans être réécrite.

## Règles de commit à tenir toute la journée

- **un commit par phase terminée**, fichiers ajoutés un par un, jamais de `git add .` en aveugle
- un fichier contenant un mot de passe n'entre jamais dans un commit, même "juste pour tester"
- phase 3 : le changement `runs-on: self-hosted` mérite son propre commit, avec un message qui dit
  **pourquoi**
- phase 7 : ne pas mélanger instrumentation et correction de route dans le même commit

## Point de départ (état actuel du dépôt)

Commits : `Initialisation de l'API` → `Mise en place de Docker et des premiers fichiers` →
`Refactor API :`. Il y a déjà `src/`, `tests/unit`, `tests/integration`, un `Dockerfile`, un
`.dockerignore`. **Il n'y a pas encore de `.github/workflows/`** → c'est exactement la phase 1.
