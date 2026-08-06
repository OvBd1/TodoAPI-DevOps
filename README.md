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
