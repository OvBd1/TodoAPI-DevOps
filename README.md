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
