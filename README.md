# Journal de bord
### Fichier 1:

```
FROM node:18-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD npm start
```

L'erreur se trouve au niveau du npm start. On doit mettre chaque argument dans un tableau de string donc : 
```
CMD ["npm", "start"]
```

### Fichier 2:
```
FROM node:18-alpine
WORKDIR /app
COPY . .
RUN npm install
EXPOSE 3000
CMD ["node", "server.js"]
```

L'erreur se trouve dans l'ordre de l'exécution. On devrait, pour optimiser la vitesse, copier le ```package.json``` puis faire un ```npm install``` et ensuite copier toute l'application. Ce qui donne :
```
COPY package*.json
RUN npm install
COPY . .
```

### Fichier 3:
```
FROM node:18
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/server.js"]
```
Premièrement, la première ligne utilise une version trop lourde de node, il faudrait rajouter alpine derrière le numéro de version : ```node:18-alpine```. Ensuite, on peut supposer que le projet n'a pas de ficher ```.dockerignore``` car dans la dernière ligne on appelle ```dist/server.js```. Or le dossier dist est lourd et contient tous les fichiers de build. De plus, s'il n'y a pas de fichier ```.dockerignore``` cela veut dire qu'il y a aussi le ```node_modules``` qui est importé dans l'image. 
---

## Phase 5 — Rejouer et revenir en arrière

### Idempotence

Rejeu de la pipeline sur le même commit (`c9f8d33`), sans rien changer.

| | avant le rejeu | après le rejeu |
|---|---|---|
| `todo-api` | id `089893eb680a`, démarré 14:29:03 | **identique** |
| `todo-db` | id `d1e7f15a2c0e`, démarré 14:09:31 | **identique** |

`docker compose up -d` compare l'état voulu à l'état réel : aucun conteneur recréé, aucun
orphelin, aucun port occupé. Une séquence de `docker run` aurait échoué sur le nom `todo-api`
déjà pris. Durée du rejeu complet : **69 s**.

### Incident volontaire et retour arrière

Régression choisie : `CMD ["npm", "run", "start:prod"]` dans le `Dockerfile`, script inexistant.
Elle passe les 36 tests, qui s'exécutent sur les sources et jamais sur l'image — c'est ce qui lui
permet d'atteindre la production.

| Moment | Heure | Écart |
|---|---|---|
| Push de la régression sur `main` | 16:40:52 | — |
| Conteneur fautif démarré en prod → **début de la panne** | 16:42:02 | T+70 s |
| Contrôle `/health` épuisé, job rouge → **constat** | 16:43:03 | T+61 s après la panne |
| Commande de retour arrière lancée | 16:43:43 | |
| **Service rétabli** | 16:43:46 | **T+3 s** |

**Constat → rétablissement : 43 s.** Panne totale : 104 s.

Le retour arrière lui-même ne prend que 3 secondes : l'image de la version précédente est déjà
sur Docker Hub, taguée au sha de son commit. Ni build, ni pipeline.

```sh
# LA commande de retour arrière
cd /srv/todo && TAG=<sha de la version précédente> docker compose up -d
```

Symptôme observé : conteneur en `Restarting (1)`, aucune réponse sur le port 3000, et dans
`docker logs todo-api` → `npm error Missing script: "start:prod"`.

### Retour arrière vers un tag inexistant

```
Error response from daemon: manifest for ovbd/todo-api:ce-tag-nexiste-pas not found
```

Code de retour **1**, et la production reste debout : l'ancien conteneur n'est jamais arrêté tant
que la nouvelle image n'a pas été téléchargée. Un retour arrière raté est donc détectable par un
script — ce qui rend possible son déclenchement depuis la pipeline.

### Durée de référence

Un déploiement normal (push → API qui répond) prend **59 s**. Au-delà de 2 minutes, il y a un
problème.

---

## Phase 8 — Prometheus, Grafana et les 4 golden signals

### Le tableau de relevés

| Moment | `up` | Requêtes/s | Taux d'erreur (5xx) | p95 |
|---|---|---|---|---|
| Au repos, avant la boucle de charge | 1 | 0,20 | 0 % | 21 ms |
| Pendant la boucle de charge | 1 | 12,64 | 0 % | 8 ms |
| Pendant l'incident (base coupée) | 1 | 0,80 | **14,2 %** | **5 s** |

Les 0,20 req/s au repos ne sont pas du bruit : ce sont exactement les collectes de Prometheus,
toutes les 5 secondes. Aucun utilisateur, et pourtant le trafic n'est jamais nul.

Le p95 **baisse** sous la charge (21 ms → 8 ms) : au repos les seules requêtes mesurées sont les
collectes de `/metrics`, plus lourdes que `/api/tasks`. Une moyenne calculée sur trois requêtes
ne veut rien dire — c'est le volume qui rend la mesure honnête.

Pendant l'incident, le taux d'erreur reste à 14 % et non à 100 % : `/health` et `/metrics`
continuent de répondre normalement. Seules les routes qui touchent la base échouent.

### Les deux signatures à savoir distinguer

| | API arrêtée | Base arrêtée |
|---|---|---|
| `up` | **0** (en 7 s) | **1** |
| `/health` | aucune réponse | 200 |
| `/api/tasks` | aucune réponse | **500 après 5 s** |
| p95 | plus de données | **5 s** |
| Taux d'erreur | plus de données | 14 % |

`up = 0` veut dire « la cible ne répond plus ». `up = 1` avec des 5xx veut dire « la cible répond,
mais ce qu'elle sert est cassé ». Confondre les deux, c'est chercher la panne au mauvais endroit.

### Checkpoint qualité

- `docker stop todo-api` → `up` tombe à 0 en **7 s** (exigé : moins de 15 s)
- source de données et tableau de bord provisionnés depuis le dépôt, aucun clic dans Grafana
- Prometheus atteint sa cible par `todo-api:3000`, le nom du service — jamais une adresse IP

### Le bug que ce relevé a révélé

Au premier essai, couper **la base** faisait tomber `up` à **0** : même signature qu'une API
arrêtée, donc deux incidents indiscernables. Deux causes cumulées :

1. l'arrêt de PostgreSQL émet un événement `error` sur un client inactif du pool ; sans écouteur,
   Node tue le processus ;
2. la migration au démarrage levait une exception non rattrapée → le conteneur redémarrait sans
   fin (**6 redémarrages** observés).

Corrigé, avec un test d'intégration qui verrouille le comportement : base injoignable →
`/health` 200, `/metrics` 200, `/api/tasks` 500, et le processus reste debout.

**Sans le relevé chiffré, ce bug serait passé inaperçu jusqu'à la passation.**

---

## Phase 9 — La procédure de déploiement

`docs/PROCEDURE_DEPLOIEMENT.md`. Éprouvée non pas en la relisant, mais en **rejouant chacun de ses
remèdes sur la vraie machine cible**, commande par commande, telles qu'elles sont écrites.

### Les remèdes, chronométrés

| Panne posée | Remède de la procédure | Rétabli en |
|---|---|---|
| API arrêtée (§7.4) | `docker compose up -d` | 6 s |
| Base arrêtée (§7.5) | `docker compose up -d todo-db` | 6 s |
| Port 3000 occupé par un orphelin (§7.8) | `docker rm -f todo-api && docker compose up -d` | 6 s |
| Retour arrière (§6) | `TAG=<sha> docker compose up -d` | 8 s |

### Trois défauts trouvés par le test, invisibles à la relecture

**1. Toutes les commandes `docker compose` de la procédure échouaient.** `compose.yml` exige la
variable `TAG`, qu'aucune commande de dépannage ne fournissait :

```
error while interpolating services.todo-api.image: required variable TAG is missing a value
```

Quatre sections étaient inapplicables. Corrigé à la racine plutôt que dans le texte : le job de
déploiement inscrit désormais `TAG=<sha>` dans `/srv/todo/.env`. La machine cible se souvient de
sa version, et `docker compose up -d` suffit pendant un incident.

**2. Un conteneur relancé hors de Compose ne peut pas être repris par `--force-recreate`.**
Compose n'en est pas propriétaire et échoue sur `Conflict. The container name "/todo-api" is
already in use`. Il faut le supprimer d'abord.

**3. L'API n'écoute qu'après ~40 s si la base est absente au démarrage** — elle réessaie dix fois
avant d'ouvrir son port. Sans cette information, l'absence de réponse pendant 30 s se lit comme un
second incident et déclenche un dépannage inutile.

### Erreur volontaire, détectée par le point de contrôle

Test : coller le sha **court** au lieu du sha complet dans la commande de retour arrière — l'erreur
la plus probable, puisque c'est ce qu'affiche `git log --oneline`.

```
Error response from daemon: manifest for ovbd/todo-api:2a2496f not found: manifest unknown
```

Code de retour **1**, message explicite, et la production est restée debout. Le point de
vérification de l'étape suivante l'attrape exactement comme annoncé.

### Signatures affinées

Deux pannes donnent un 500 sur `/api/tasks` et se distinguent au chronomètre :

| | Base arrêtée | Conteneur relancé sans configuration |
|---|---|---|
| `/api/tasks` répond en | **~5 s** | **~12 ms** |
| `todo-db` | `Exited` | **`Up (healthy)`** |

---

## Phase 10 — Préparation de la passation

`scripts/incident.sh` est en place et a été **exécuté à blanc** sur la machine cible pour vérifier
qu'il fonctionne : tirage silencieux, panne appliquée, réponse consignée dans `/root/.incident`.

Deux préparatifs sans lesquels la passation aurait mal commencé :

- `od -An -N1 -tu1 /dev/urandom` fonctionne bien avec le busybox de l'image `dind` (vérifié :
  tirages variés sur 6 essais)
- l'image `alpine` était **absente** de la machine cible. Sans pré-téléchargement, l'incident 5
  aurait dépendu du réseau au pire moment. Elle est maintenant en cache.

### Les 5 incidents, éprouvés un par un

| # | Panne | `up` | `/health` | `/api/tasks` | Conteneur | Couvert par |
|---|---|---|---|---|---|---|
| 1 | API arrêtée | 0 | — | — | `Exited` | §7.4 |
| 2 | Base arrêtée | 1 | 200 | 500 en ~5 s | `Up` | §7.5 |
| 3 | API coupée du réseau | **0** | — | — | **`Up`** | **§7.9** |
| 4 | Relancée sans configuration | 1 | 200 | 500 en ~12 ms | `Up` | §7.7 |
| 5 | Machine saturée | 1 | 200 | 200 | `Up` + 4 intrus | §7.6 |

### Deux corrections que ces tests ont imposées

**Les incidents 1 et 3 sont indiscernables sur le tableau de bord.** Les deux donnent `up = 0` et
un silence total. Le seul discriminant est `docker ps -a` : conteneur `Exited` dans un cas, `Up`
dans l'autre. La procédure ne couvrait pas le cas 3 — une section §7.9 a été ajoutée, et le §7.4
renvoie désormais vers elle explicitement. Remède : `docker network connect todo_default todo-api`,
une seconde, sans recréer le conteneur.

**L'incident 5 ne ralentit presque pas l'API.** J'avais écrit « tout répond mais lentement ».
Mesure réelle sur 8 cœurs avec 4 conteneurs parasites à 99 % : le p95 passe de **8 ms à 37 ms** et
l'API répond normalement. Le tableau de bord reste au vert. Le vrai signal n'est pas la latence
mais la **présence de conteneurs qui ne devraient pas exister** — la stack en compte exactement
quatre. La section §7.6 a été réécrite en conséquence.

C'est la panne la plus difficile à voir depuis Grafana, et je ne l'aurais pas su en me contentant
de raisonner.

### Reste à faire, le jour de la passation

- lancer `incident.sh` sur sa propre machine, sans regarder
- jouer les deux rôles avec un binôme (les mains / le pilote), chronomètre en main
- consigner ici les **deux entrées** : temps de rétablissement, panneau le plus utile, ligne
  manquante de la procédure

---

# Jour 4 — Kubernetes

La cible n'est plus `vm-prod` mais `todo-cluster`, un cluster k3d d'un seul node. Les trois
limites nommées la veille — coupure à chaque déploiement, personne pour relever l'app à 3 h du
matin, une seule copie pour encaisser le trafic — sont mesurées ci-dessous, une par une.

## Phase 6 — Trois copies, et la preuve que le trafic se répartit

`charge.sh 30` via l'Ingress, puis `/metrics` interrogé **pod par pod**, en contournant le Service
pour ne pas se mentir à soi-même.

| Pod | `http_requests_total{route="/api/tasks"}` avant | après |
|---|---|---|
| `todo-api-…-bkjjm` | 0 | **79** |
| `todo-api-…-tdpgb` | 0 | **80** |
| `todo-api-…-wk4z5` | 0 | **80** |

239 requêtes émises, 239 comptées, réparties à une unité près. Ce n'est pas un pod chanceux qui a
tout pris.

Contre-épreuve : un `selector` de Service qui ne colle à aucun pod donne **trois pods `Running` et
49 échecs sur 49 requêtes**. `kubectl get endpoints todo-api -n todo` affiche `<none>` — c'est là
que ça se voit, pas dans `get pods`.

## Phase 8 — Le rolling update sous charge

Protocole : `charge.sh 60` dans un terminal, `kubectl set image` dans un second.

| Déploiement | Requêtes échouées | Secondes d'indisponibilité | Convergence |
|---|---|---|---|
| Hier, SSH manuel (Jour 3) | non mesuré en continu | **~70 s** de panne totale | 59 s |
| `maxSurge: 1` / `maxUnavailable: 0` | **2 / 235** | 0 | 28 s |
| Le même, rejoué | **2 / 242** | 0 | 22 s |
| Réglage par défaut (25 % / 25 %) | **2 / 246** | 0 | 22 s |
| Avec `preStop: sleep 5` | **0 / 483** | 0 | 22 s |

### Ce que ce tableau a révélé

`maxUnavailable: 0` **ne suffit pas**, et le réglage par défaut donne exactement le même compte :
deux requêtes tombent à chaque mise à jour, un `502` puis un `504`, trois fois de suite.

Ce n'est donc pas une baisse de capacité — il y a toujours eu trois pods prêts. C'est la fenêtre
entre l'instant où un pod reçoit son `SIGTERM` et l'instant où Traefik le retire de ses endpoints :
pendant ce battement, le proxy route encore vers un pod qui ferme déjà ses sockets.

Un `preStop` de 5 secondes referme cette fenêtre — le pod continue de répondre pendant que le
cluster le retire des endpoints. **0 échec sur 483 requêtes**, confirmé deux fois.

Sans le compteur, j'aurais écrit « zéro coupure » sur la foi de `maxUnavailable: 0`, et c'était
faux à 0,85 %.

## Phase 9 — Le retour arrière, chronométré contre celui d'hier

Deux régressions, deux histoires différentes.

**Régression 1 — un tag qui n'existe pas.** Elle n'atteint jamais la production : le pod reste en
`ImagePullBackOff`, les trois anciens continuent de servir, `/api/tasks` répond `200` tout du long.
Constat → rétablissement : **1 s**, mais il n'y avait rien à rétablir.

**Régression 2 — une image qui démarre et casse `/api/tasks`.** Celle-là passe, parce que
`/health` continue de répondre `200` et que la readiness la déclare prête.

| Moment | Heure | Écart |
|---|---|---|
| Push de la régression | 15:18:37 | — |
| Première requête utilisateur en 500 → **constat** | 15:18:45 | T+8 s |
| `kubectl rollout undo` lancé | 15:18:45 | |
| **Service rétabli** | 15:18:48 | **T+3 s** |

**Constat → rétablissement : 3 s**, contre **43 s** hier pour la même opération en SSH. Pas de sha
à retrouver, pas de tag à coller : la révision précédente est déjà dans le cluster.

`kubectl rollout history` liste 11 révisions, et `--to-revision=N` en cible n'importe laquelle. Un
`rollout undo` sans historique échoue proprement : `no rollout history found`, code 1, cluster
intact.

## Phase 10 — Cinq pannes, dont deux qu'il répare seul

| # | Panne | `kubectl get pods` | `describe` / logs | Se répare seule ? | Remède | Service coupé ? |
|---|---|---|---|---|---|---|
| 1 | Pod supprimé | un pod en moins, un neuf en `ContainerCreating` | events `Killing` puis `Created` | **oui, ~30 s** | aucun | non |
| 2 | Processus tué dans le conteneur | `0/1 Running`, `RESTARTS` à 1 | `Last State: Terminated`, `Error`, exit 1 | **oui, ~25 s** | aucun | non |
| 3 | Tag d'image inexistant | `0/1 ImagePullBackOff`, anciens `1/1` | `Failed to pull image … not found` | non | `kubectl rollout undo` (1 s) | non |
| 4 | Clé `DB_PASSWORD` retirée du Secret | **trois pods `1/1 Running`** | **rien dans les events** ; logs : `password authentication failed` | non | `apply` du Secret + `rollout restart` (23 s) | **oui, total** |
| 5 | `limits.memory` à 8Mi | `0/1 CrashLoopBackOff`, `RESTARTS` grimpe | `Last State: Terminated`, `OOMKilled`, exit 137 | non | retirer la limite (1 s) | non |

### Ce que le tableau dit, et que je n'avais pas prévu

**Quatre pannes sur cinq ne coupent rien.** Trois copies tournent, `maxUnavailable: 0` interdit
qu'une copie saine parte avant qu'une neuve soit prête — donc un déploiement cassé reste bloqué à
la porte. La panne 3 a laissé un pod en `ImagePullBackOff` pendant que `/api/tasks` répondait 200,
et la panne 5 un pod en `CrashLoopBackOff` pendant **19 minutes** sans qu'une seule requête tombe.

**La cinquième est la seule vraie panne, et c'est la seule que le cluster ne signale nulle part.**
Trois pods `1/1 Running`, zéro redémarrage, aucun event anormal, `/health` à 200 — et toutes les
requêtes en erreur. Elle passe même le rolling update sans encombre, puisque la readiness la
déclare prête.

**Le chrono du 500 sépare les deux pannes qui se ressemblent** : `500 en ~20 ms` veut dire « la
base refuse » (configuration cassée), `500 après ~21 s` veut dire « la base ne répond pas »
(pod absent). Ce sont deux sections différentes de la procédure.

## Phase 12 — Jusqu'où serrer les ressources

Mesuré avec `kubectl top pods` : **42 à 48 Mi** par pod, au repos comme sous charge, et 8 à 20 m
de CPU (pics à 87 m au démarrage).

| `limits.memory` essayée | Résultat | Requêtes perdues |
|---|---|---|
| 128Mi | tient | 0 / 200 |
| 64Mi | tient | 0 / 196 |
| 48Mi | tient | 0 / 205 |
| **40Mi** | **`OOMKilled`, exit 137, `CrashLoopBackOff`** | 0 / 199 |

Retenu : `requests` 50m / 48Mi, `limits` 500m / **64Mi** — un cran au-dessus de la valeur qui
casse, avec 16 Mi de marge sur le pic mesuré. Vérifié par un rolling update sous charge à ce
réglage : **0 échec sur 490 requêtes**.

Deux choses apprises en chemin :

- l'api-server **refuse** un `requests` supérieur à son `limits` : `must be less than or equal to
  memory limit of 48Mi`. La validation tombe avant que quoi que ce soit ne soit créé.
- même à 40 Mi, aucune requête n'est perdue : le pod fautif ne devient jamais prêt, donc le rollout
  se bloque au lieu de propager la casse. **Le chiffre à retenir n'est pas « ça tient », c'est
  « ça tient et le rollout converge ».**

## Ce que le TP n'avait pas prévu, et que le dépôt a corrigé

**Le modèle de Secret était un piège.** `k8s/todo-secret.example.yaml` avec sa valeur factice était
appliqué par un `kubectl apply -f k8s/` au même titre que le vrai fichier. L'ordre alphabétique
faisait que le vrai repassait derrière — mais sur une machine où `k8s/todo-secret.yaml` n'existe
pas encore, la base serait partie avec le mot de passe `remplacer-par-…`. Le modèle vit maintenant
dans `docs/`, hors du dossier qu'on applique.

**Une PVC supprimée ne casse rien tout de suite.** `kubectl delete pvc` pendant que le pod tourne
reste bloqué sur le finalizer `kubernetes.io/pvc-protection`, et `kubectl get pvc` affiche
`Terminating` — un état qu'on peut regarder sans s'inquiéter. Au premier redémarrage du pod, la
PVC se libère, disparaît, et le pod suivant reste `Pending` sur
`persistentvolumeclaim "todo-db-data" is being deleted`. Il n'existe aucun moyen d'annuler la
suppression : les données sont perdues à cet instant-là, pas au moment du `delete`.

**Traefik répond 404, pas 502, sur un port de Service inexistant.** Un Ingress qui vise le port
3000 (celui du conteneur) au lieu de 80 (celui du Service) ne produit pas d'erreur de passerelle :
la route n'est simplement jamais construite, et c'est le routeur par défaut qui répond. Un 404 sur
un déploiement neuf se lit donc « ma règle de routage est fausse », jamais « mon application est
en panne ».

## Phase 11 — La procédure éprouvée sur un incident tiré au hasard

`chaos.sh` a tiré l'incident **4** sans que je le sache. Diagnostic posé en suivant
`docs/PROCEDURE_DEPLOIEMENT.md` au mot près : contexte vérifié (§1), tableau du §7 lu de gauche à
droite, §7.9 atteint sur la signature `/health` 200 + `/api/tasks` 500 en 16 ms. Remède appliqué
tel qu'écrit, **rétabli en 25 s**. La réponse du tirage, lue après coup : `4`.

Deux défauts que seule cette exécution a montrés, corrigés dans le fichier :

1. **L'état transitoire manquait.** Pendant le rolling update qui propage la configuration cassée,
   on voit un pod `0/1 Running` avec `RESTARTS` à 0 pendant que `/api/tasks` répond encore `200`.
   Rien dans le tableau ne décrivait ce moment, et il ressemble à une panne différente.
2. **`kubectl logs --tail=5` ne montre pas la cause.** Les dernières lignes disent
   `migration impossible : l'API demarre sans schema` — qu'il y a un problème, pas lequel. La
   ligne qui nomme la variable fautive est écrite au démarrage, il faut la chercher :
   `--tail=100 | grep -iE "authentication|migration"`.

## Ce qui reste vrai des trois limites d'hier

| Limite du Jour 3 | Aujourd'hui |
|---|---|
| Chaque déploiement coupe le service | **fausse** — 0 échec sur 483 requêtes pendant un rolling update, une fois le `preStop` posé |
| Rien ne relève l'app à 3 h du matin | **fausse pour deux pannes sur cinq** — pod supprimé et processus mort reviennent seuls en ~30 s. Les trois autres attendent toujours une main humaine |
| Grossir demande une intervention manuelle | **fausse** — `replicas: 3` dans un fichier, et le Service retrouve les pods par leur étiquette sans qu'on y touche |

Une limite nouvelle a pris leur place : **le cluster ne surveille plus rien de ce qu'il ne voit
pas**. Prometheus et Grafana scrapent encore une adresse fixe qui n'existe plus, la panne 4 ne
déclenche aucune alerte, et le seul contrôle qui engage quelque chose reste un `curl` sur
`/api/tasks` tapé à la main.
