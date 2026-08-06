# Procédure de déploiement — Todo API

Ce document s'adresse à quelqu'un qui n'a jamais vu ce projet. Toutes les commandes se copient
telles quelles. Aucun chemin, aucun nom et aucun port ne sont à deviner.

**En cas de panne, allez directement au [§6 Retour arrière](#6-retour-arrière) : rétablir d'abord,
comprendre ensuite.**

---

## 1. Ce qu'il faut avoir sous la main

| Élément | Valeur |
|---|---|
| Dépôt Git | `https://github.com/OvBd1/TodoAPI-DevOps` |
| Machine cible | `localhost`, port SSH **2222**, utilisateur **root** |
| Clé privée SSH | fichier `deploy_key`, à la racine du dépôt local (**jamais versionné**) |
| Dossier de travail sur la cible | `/srv/todo` |
| Registre d'images | `ovbd/todo-api` sur Docker Hub (public) |
| API | http://localhost:3000 |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3001 (lecture sans mot de passe) |

Fichiers présents sur la machine cible, dans `/srv/todo` :

| Fichier | Origine | Modifiable à la main ? |
|---|---|---|
| `compose.yml` | envoyé par la pipeline | **non** — modifiez le dépôt |
| `prometheus.yml` | envoyé par la pipeline | **non** — modifiez le dépôt |
| `grafana/` | envoyé par la pipeline | **non** — modifiez le dépôt |
| `.env` | mots de passe copiés **une fois à la main**, ligne `TAG=` réécrite à chaque déploiement | oui, mais il n'entre jamais dans Git |

La ligne `TAG=` de `/srv/todo/.env` retient la version actuellement déployée. C'est elle qui
permet de taper `docker compose up -d` sans rien préciser. Pour la lire :

```sh
vm 'grep TAG= /srv/todo/.env'
```

Raccourci utilisé partout dans ce document — collez-le une fois dans votre terminal :

```sh
cd ~/Documents/todo-api
alias vm='ssh -i deploy_key -p 2222 -o StrictHostKeyChecking=no root@localhost'
```

**Vérification :** `vm 'echo ok'` répond `ok`.
Si la réponse est `Connection refused`, allez au [§7.1](#71-connection-refused-sur-le-port-2222).

---

## 2. Déploiement normal

Le déploiement est automatique. **Un push sur `main`, et rien d'autre.**

### Étape 1 — Vérifier que le runner est en ligne

Le job de déploiement s'exécute sur un runner installé sur le PC de l'équipe, pas chez GitHub.
S'il est éteint, le job attend indéfiniment sans message d'erreur.

```sh
gh api /repos/OvBd1/TodoAPI-DevOps/actions/runners -q '.runners[] | "\(.name) \(.status)"'
```

**Vérification :** la commande affiche `pc-yanis online`.
Si elle affiche `offline`, allez au [§7.2](#72-le-job-deploy-reste-en-queued).

### Étape 2 — Vérifier que la machine cible tourne

```sh
docker ps --filter name=vm-prod --format '{{.Names}} {{.Status}}'
```

**Vérification :** la commande affiche `vm-prod Up ...`.
Si elle n'affiche rien, allez au [§7.1](#71-connection-refused-sur-le-port-2222).

### Étape 3 — Pousser sur `main`

```sh
git push origin main
```

**Vérification :** la commande affiche une ligne `main -> main`.

### Étape 4 — Suivre la pipeline

```sh
gh run watch
```

**Vérification :** les quatre jobs passent au vert dans cet ordre : `test`, `integration`,
`build`, `deploy`.

- si `test` ou `integration` échoue → **rien n'est déployé**, la production n'a pas bougé.
  Corrigez le code, rien d'autre à faire.
- si `build` échoue → voir [§7.3](#73-le-job-build-échoue-à-la-connexion-docker-hub).
- si `deploy` échoue → la production **a peut-être déjà changé**. Allez au [§6](#6-retour-arrière).

### Étape 5 — Vérifier que l'API répond

```sh
curl -s http://localhost:3000/health
```

**Vérification :** la commande répond exactement `{"status":"ok","timestamp":"..."}`.

### Étape 6 — Vérifier que la version déployée est la bonne

```sh
vm 'docker inspect -f "{{.Config.Image}}" todo-api'
git rev-parse HEAD
```

**Vérification :** les deux commandes affichent le **même identifiant** (le premier après
`todo-api:`, le second en entier). S'ils diffèrent, le déploiement n'a pas abouti : allez au
[§6](#6-retour-arrière).

### Étape 7 — Vérifier le tableau de bord

Ouvrez http://localhost:3001 → tableau de bord **Todo API — 4 golden signals**.

**Vérification :** le panneau **Disponibilité** affiche `EN LIGNE` en vert.

---

## 3. Durée attendue

| Étape | Durée normale |
|---|---|
| Pipeline complète (push → API qui répond) | **~60 s** |
| Dont le job `deploy` seul | ~15 s |
| Retour arrière | **~5 s** |

**Au-delà de 2 minutes sans que l'API réponde, considérez qu'il y a un problème** et passez au
[§6](#6-retour-arrière). N'attendez pas davantage : le retour arrière prend 5 secondes, il coûte
moins cher que le diagnostic.

---

## 4. Première installation d'une machine cible

À ne faire qu'une fois. Si la machine existe déjà, sautez cette section.

```sh
# 1. La clé de déploiement (la ligne deploy_key doit déjà être dans .gitignore)
ssh-keygen -t ed25519 -N "" -f deploy_key

# 2. L'image de la machine cible
docker build -f Dockerfile.vm -t vm-prod .

# 3. Le conteneur, avec ses quatre ports
docker run -d --privileged --name vm-prod \
  -p 2222:22 -p 3000:3000 -p 9090:9090 -p 3001:3001 \
  -v vm-prod-data:/var/lib/docker \
  vm-prod
```

**Vérification :** `vm 'docker run --rm hello-world'` affiche `Hello from Docker!`.

Puis le fichier de mots de passe, **copié à la main, une seule fois** :

```sh
vm 'mkdir -p /srv/todo'
cat > /tmp/env-prod <<'EOF'
POSTGRES_DB=todo
POSTGRES_USER=todo
POSTGRES_PASSWORD=CHANGEZ_MOI
EOF
scp -i deploy_key -P 2222 /tmp/env-prod root@localhost:/srv/todo/.env
rm /tmp/env-prod
```

**Vérification :** `vm 'cut -d= -f1 /srv/todo/.env'` affiche les trois clés `POSTGRES_DB`,
`POSTGRES_USER`, `POSTGRES_PASSWORD`.

Enfin, les quatre secrets GitHub (`Settings > Secrets and variables > Actions`) :
`DEPLOY_SSH_KEY` (contenu de `deploy_key`), `DEPLOY_HOST`, `DEPLOY_PORT`, `DEPLOY_USER`,
plus `DOCKERHUB_USERNAME` et `DOCKERHUB_TOKEN`.

---

## 5. Après un redémarrage du PC

Deux choses ne repartent pas toutes seules :

```sh
docker start vm-prod
cd ~/actions-runner && ./run.sh
```

Le second terminal doit **rester ouvert**. La stack applicative (API, base, Prometheus, Grafana),
elle, repart seule : tous les services sont en `restart: unless-stopped`.

**Vérification :** attendez ~30 s, puis `curl -s http://localhost:3000/health` répond `ok`.

---

## 6. Retour arrière

### Quand le déclencher

Déclenchez sans hésiter dès **l'une** de ces conditions :

- le panneau **Disponibilité** affiche `HORS SERVICE` plus de 1 minute
- le panneau **Erreurs** dépasse **5 %** plus de 2 minutes
- `curl http://localhost:3000/health` ne répond pas 2 minutes après un déploiement
- le job `deploy` est rouge à l'étape « Vérifier que l'API répond »

### Qui décide

**La personne d'astreinte décide seule et n'a besoin d'aucune validation.** Un retour arrière
prend 5 secondes et n'a aucun effet de bord : il ne détruit pas de données et se rejoue autant de
fois que nécessaire. En cas de doute, revenez en arrière.

### Comment faire

**Étape 1 — Trouver la version précédente**

```sh
git log --format='%H %s' -5
```

**Vérification :** la commande affiche 5 lignes. Prenez l'identifiant complet de la **2ᵉ ligne**
(la version d'avant le déploiement fautif).

**Étape 2 — Revenir à cette version**

```sh
vm 'cd /srv/todo && TAG=COLLEZ_ICI_L_IDENTIFIANT docker compose up -d'
```

**Vérification :** la commande affiche `Container todo-api Started`.
Si elle affiche `manifest unknown`, l'identifiant est faux : reprenez l'étape 1. La production
n'a pas bougé, l'ancienne version tourne toujours.

**Étape 3 — Confirmer le rétablissement**

```sh
curl -s http://localhost:3000/health
```

**Vérification :** répond `{"status":"ok",...}` en moins de 5 secondes.

**Étape 4 — Empêcher le retour de la panne**

Le prochain push sur `main` **redéploiera la version fautive**. Annulez-la dans le dépôt :

```sh
git revert <identifiant du commit fautif>
git push origin main
```

**Vérification :** la pipeline repasse au vert et l'étape 6 du [§2](#2-déploiement-normal) montre
le nouvel identifiant.

---

## 7. Pannes connues et leur signature

### Tableau de diagnostic

Lisez ce tableau **de gauche à droite** : `up` d'abord, il sépare les pannes en deux familles.

| `up` | `/health` | `/api/tasks` | Diagnostic | Aller à |
|---|---|---|---|---|
| **0** | pas de réponse | pas de réponse | l'API est arrêtée ou plantée | [§7.4](#74-lapi-est-arrêtée-ou-en-boucle-de-crash) |
| **1** | 200 | **500 après ~5 s** | la base est injoignable | [§7.5](#75-la-base-est-injoignable) |
| **1** | 200 | 200 mais très lent | la machine est saturée | [§7.6](#76-la-machine-est-saturée) |
| **1** | 200 | 200 | l'API va bien — cherchez ailleurs | — |

Repère chiffré : **au repos le trafic est de 0,2 req/s** (les collectes de Prometheus) et le
**p95 est sous 25 ms**. Un p95 à 5 secondes signe une base injoignable.

### 7.1 `Connection refused` sur le port 2222

La machine cible est éteinte.

```sh
docker start vm-prod
sleep 15
vm 'echo ok'
```

**Vérification :** répond `ok`. Le `sleep` n'est pas décoratif — le Docker interne met ~8 s à
démarrer, et une commande lancée trop tôt échoue sans raison lisible.

### 7.2 Le job `deploy` reste en `Queued`

Le runner est éteint. Aucun message d'erreur n'est affiché : le job attend, c'est tout.

```sh
cd ~/actions-runner && ./run.sh
```

**Vérification :** le terminal affiche `Listening for Jobs`, et le job démarre dans les 30 s.
Ce terminal doit rester ouvert.

### 7.3 Le job `build` échoue à la connexion Docker Hub

Message dans le log : `Password required` ou `unauthorized`.

Le secret `DOCKERHUB_TOKEN` est absent ou expiré. Recréez-le dans
`Settings > Secrets and variables > Actions`.

**Vérification :** relancez le run (`gh run rerun <id>`), le job `build` passe au vert.
Les jobs `test` et `integration` étaient déjà verts et le restent : cette panne n'affecte que la
publication.

### 7.4 L'API est arrêtée ou en boucle de crash

**Signature :** panneau Disponibilité `HORS SERVICE`, `up = 0`, aucune réponse sur le port 3000.

```sh
vm 'docker ps -a --format "{{.Names}}\t{{.Status}}" | grep todo-api'
```

- statut `Restarting` → l'application plante au démarrage. Lisez la cause :
  ```sh
  vm 'docker logs --tail 30 todo-api'
  ```
  Puis **retour arrière** ([§6](#6-retour-arrière)).
- statut `Exited` → elle a été arrêtée :
  ```sh
  vm 'cd /srv/todo && docker compose up -d'
  ```

**Vérification :** `up` repasse à 1 sur le tableau de bord en moins de 15 s.

### 7.5 La base est injoignable

**Signature :** `up = 1`, `/health` répond 200, `/api/tasks` répond **500 après ~5 s**,
le panneau Latence monte à **5 s** et le panneau Erreurs à ~14 %.

L'API reste debout volontairement dans ce cas : elle sert `/health` et `/metrics` pour rester
diagnosticable.

```sh
vm 'docker ps -a --format "{{.Names}}\t{{.Status}}" | grep todo-db'
vm 'cd /srv/todo && docker compose up -d todo-db'
```

**Vérification :** `curl -s http://localhost:3000/api/tasks` répond une liste JSON en moins de
1 seconde.

### 7.6 La machine est saturée

**Signature :** `up = 1`, tout répond mais lentement, le p95 monte sans que le trafic augmente,
et le panneau **Ressources** montre le CPU au plafond.

```sh
vm 'docker stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}"'
```

Repérez les conteneurs qui ne font pas partie de la stack (autres que `todo-api`, `todo-db`,
`prometheus`, `grafana`) et supprimez-les :

```sh
vm 'docker rm -f NOM_DU_CONTENEUR'
```

**Vérification :** le p95 redescend sous 100 ms en moins d'une minute.

### 7.7 L'API tourne mais sans sa configuration

**Signature :** `up = 1`, `/health` répond, mais `/api/tasks` échoue alors que `todo-db` tourne
et est `healthy`.

**Ce qui distingue ce cas du [§7.5](#75-la-base-est-injoignable)** — les deux donnent un 500 sur
`/api/tasks`, mais :

| | §7.5 base arrêtée | §7.7 conteneur mal relancé |
|---|---|---|
| `/api/tasks` répond en | **~5 s** | **~12 ms** |
| `todo-db` | `Exited` | **`Up (healthy)`** |

Le conteneur a été relancé à la main, hors de Compose : il a perdu ses variables d'environnement
et son réseau. Compose ne peut pas le reprendre en main — il n'en est pas propriétaire et
échouerait sur `Conflict. The container name "/todo-api" is already in use`. Il faut donc le
**supprimer d'abord** :

```sh
vm 'docker rm -f todo-api && cd /srv/todo && docker compose up -d'
```

Comptez **~40 s** avant que l'API réponde : au démarrage elle réessaie la connexion à la base
dix fois avant d'ouvrir son port. Une absence de réponse dans les 30 premières secondes est
normale, pas un second incident.

**Vérification :** `curl -s http://localhost:3000/api/tasks` répond une liste JSON.

### 7.8 Le port 3000 est déjà occupé

**Signature :** le déploiement échoue avec `port is already allocated`.

```sh
vm 'docker ps -a --format "{{.Names}}\t{{.Ports}}" | grep 3000'
```

Un conteneur `todo-api` orphelin occupe le port. Supprimez-le, puis relancez par Compose :

```sh
vm 'docker rm -f todo-api && cd /srv/todo && docker compose up -d'
```

**Vérification :** `curl -s http://localhost:3000/health` répond `ok`.

Si le port est occupé par un processus **hors Docker**, le conflit vient de l'hôte : identifiez-le
avec `ss -ltnp | grep 3000` sur le PC (et non sur la machine cible).

---

## 8. Ce que cette procédure ne couvre pas

Dites-le plutôt que de laisser chercher :

- **restaurer les données** de la base après une perte : aucune sauvegarde n'est en place. Le
  volume `todo_todo-db-data` survit aux redéploiements, mais rien ne survit à sa suppression.
- **déployer ailleurs que sur la machine maquette** : les adresses sont codées pour `localhost`.
- **changer un mot de passe de base** : il faut modifier `/srv/todo/.env` à la main puis
  `docker compose up -d`, et les données existantes restent liées à l'ancien utilisateur.
