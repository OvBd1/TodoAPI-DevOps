# Procédure de déploiement — Todo API

Ce document s'adresse à quelqu'un qui n'a jamais vu ce projet. Toutes les commandes se copient
telles quelles. Aucun chemin, aucun nom, aucun namespace ne sont à deviner.

La cible n'est plus une machine mais un **cluster Kubernetes**. Le cluster répare tout seul une
partie de ce que cette procédure décrivait à la main : ce qu'il ne sait pas réparer est au
[§7](#7-pannes-connues-et-leur-signature).

**En cas de panne, allez directement au [§6 Retour arrière](#6-retour-arrière) : rétablir d'abord,
comprendre ensuite.**

---

## 1. Ce qu'il faut avoir sous la main

| Élément | Valeur |
|---|---|
| Dépôt Git | `https://github.com/OvBd1/TodoAPI-DevOps` |
| Cluster | `todo-cluster`, créé par k3d, tourne sur le PC de l'équipe |
| Contexte kubectl | `k3d-todo-cluster` |
| Namespace | `todo` — **aucune commande de ce document ne marche sans `-n todo`** |
| Manifestes | dossier `k8s/` du dépôt |
| Registre d'images | `ovbd/todo-api` sur Docker Hub (public) |
| API | http://todo.localhost:8080 |
| Kubeconfig | `~/.kube/config`, écrit par k3d — **jamais versionné** |

Trois objets tournent dans le namespace `todo` :

| Objet | Rôle | Replicas |
|---|---|---|
| `deployment/todo-api` | l'API, trois copies derrière le Service | 3 |
| `deployment/todo-db` | PostgreSQL, ses données dans la PVC `todo-db-data` | 1 |
| `ingress/todo-ingress` | route `todo.localhost` vers le Service `todo-api` | — |

Collez ceci une fois dans votre terminal, avant toute autre commande :

```sh
cd ~/Documents/todo-api
kubectl config use-context k3d-todo-cluster
```

**Vérification :** `kubectl get nodes` affiche une ligne `k3d-todo-cluster-server-0 Ready`.

Si elle affiche autre chose, ou une erreur de connexion, allez au
[§7.1](#71-kubectl-ne-répond-pas-ou-pointe-ailleurs). **Vérifiez-le systématiquement avant de
diagnostiquer quoi que ce soit** : un `kubectl` pointé sur un autre cluster répond sans erreur et
affiche des objets qui n'ont rien à voir.

> Le Grafana et le Prometheus du Jour 3 tournent encore dans `vm-prod`, mais **ils ne surveillent
> plus la production** : ils scrapent une adresse fixe qui n'existe plus dans le cluster. Un
> panneau au vert ne prouve rien aujourd'hui. Le diagnostic passe par `kubectl`, pas par le
> tableau de bord.

---

## 2. Déploiement normal

Le déploiement est automatique. **Un push sur `main`, et rien d'autre.**

### Étape 1 — Vérifier que le runner est en ligne

```sh
gh api /repos/OvBd1/TodoAPI-DevOps/actions/runners -q '.runners[] | "\(.name) \(.status)"'
```

**Vérification :** la commande affiche `pc-yanis online`.
Si elle affiche `offline`, allez au [§7.2](#72-le-job-deploy-reste-en-queued).

### Étape 2 — Vérifier que le cluster tourne

```sh
kubectl get nodes
kubectl get pods -n todo
```

**Vérification :** un node `Ready`, trois pods `todo-api` en `1/1 Running` et un pod `todo-db` en
`1/1 Running`.
Si `kubectl` ne répond pas, allez au [§7.1](#71-kubectl-ne-répond-pas-ou-pointe-ailleurs).

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
- si `build` échoue → voir [§7.3](#73-le-job-build-échoue-à-la-connexion-docker-hub).
- si `deploy` échoue à l'étape « Attendre la convergence du rollout » → **la production n'a pas
  changé**. `maxUnavailable: 0` garantit qu'aucun ancien pod n'est parti tant que le nouveau
  n'était pas prêt. Lisez la cause au [§7.6](#76-le-rollout-ne-converge-pas), le retour arrière
  n'est pas urgent.

### Étape 5 — Vérifier que l'API répond par sa vraie porte d'entrée

```sh
curl -s -H "Host: todo.localhost" http://localhost:8080/health
curl -s -o /dev/null -w '%{http_code}\n' -H "Host: todo.localhost" http://localhost:8080/api/tasks
```

**Vérification :** la première répond `{"status":"ok","timestamp":"..."}`, la seconde affiche
`200`.

**Les deux commandes comptent.** `/health` répond `ok` même quand la base est injoignable ou que
le mot de passe est faux — voir [§7.7](#77-la-limite-de-health-ce-quil-ne-teste-pas). Seule la
seconde prouve que l'application rend le service attendu.

### Étape 6 — Vérifier que la version déployée est la bonne

```sh
kubectl get deployment todo-api -n todo -o jsonpath='{.spec.template.spec.containers[0].image}'
git rev-parse HEAD
```

**Vérification :** les deux commandes affichent le **même identifiant** (le premier après
`todo-api:`, le second en entier). S'ils diffèrent, le déploiement n'a pas abouti : allez au
[§6](#6-retour-arrière).

---

## 3. Durée attendue

| Étape | Durée normale |
|---|---|
| Pipeline complète (push → API à jour) | **~60 s** |
| Dont le job `deploy` seul | ~25 s |
| Retour arrière (`rollout undo`, constat → rétablissement) | **~3 s** |

**Au-delà de 2 minutes sans que `/api/tasks` réponde 200, considérez qu'il y a un problème** et
passez au [§6](#6-retour-arrière).

Il n'y a plus de fenêtre de coupure à négocier : le rolling update mesuré sous charge ne perd
aucune requête (0 échec sur 483). Le seul chiffre qui compte encore est celui du retour arrière
ci-dessus.

---

## 4. Première installation d'un cluster

À ne faire qu'une fois. Si `kubectl get nodes` répond, sautez cette section.

```sh
# 1. k3d, sans droits root
curl -sL https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh \
  | USE_SUDO=false K3D_INSTALL_DIR=$HOME/.local/bin bash

# 2. Libérer le port 8080 et le port 3000 s'ils sont pris par la maquette d'hier
docker stop vm-prod

# 3. Le cluster, avec son port d'entrée déjà mappé
k3d cluster create todo-cluster -p "8080:80@loadbalancer"
```

**Vérification :** `kubectl get nodes` affiche `k3d-todo-cluster-server-0 Ready`.

Puis le namespace et le Secret, **copié à la main, une seule fois** :

```sh
kubectl create namespace todo
cp docs/todo-secret.example.yaml k8s/todo-secret.yaml
# remplacez la valeur de DB_PASSWORD dans k8s/todo-secret.yaml, puis :
kubectl apply -f k8s/todo-secret.yaml
```

**Vérification :** `kubectl get secret todo-secret -n todo` affiche `3` dans la colonne `DATA`.

> `k8s/todo-secret.yaml` n'est pas versionné. Son modèle vit dans `docs/`, **hors de `k8s/`**,
> pour qu'un `kubectl apply -f k8s/` ne l'applique jamais avec sa valeur factice.

Enfin le reste des objets, dans cet ordre :

```sh
kubectl apply -f k8s/todo-config.yaml
kubectl apply -f k8s/todo-db.yaml
kubectl apply -f k8s/todo-api-deployment.yaml
kubectl apply -f k8s/todo-api-service.yaml
kubectl apply -f k8s/todo-ingress.yaml
```

**Vérification :** `kubectl get pvc -n todo` affiche `todo-db-data Bound`, et l'étape 5 du
[§2](#2-déploiement-normal) répond `200`.

Les secrets GitHub restent ceux d'hier moins les quatre de SSH : seuls `DOCKERHUB_USERNAME` et
`DOCKERHUB_TOKEN` servent encore. Le job `deploy` parle au cluster par le kubeconfig du runner,
sans aucun secret.

---

## 5. Après un redémarrage du PC

Deux choses ne repartent pas toutes seules :

```sh
k3d cluster start todo-cluster
cd ~/actions-runner && ./run.sh
```

Le second terminal doit **rester ouvert**. Les pods, eux, repartent seuls : c'est le travail de la
boucle de réconciliation.

**Vérification :** attendez ~60 s, puis l'étape 5 du [§2](#2-déploiement-normal) répond `200`.

---

## 6. Déploiement d'urgence et retour arrière

### 6.1 Quand déclencher un retour arrière

Déclenchez sans hésiter dès **l'une** de ces conditions :

- `curl -H "Host: todo.localhost" http://localhost:8080/api/tasks` ne répond pas `200` plus de
  1 minute après un déploiement
- le job `deploy` est rouge à l'étape « Vérifier que l'API répond par sa vraie porte d'entrée »
- `kubectl get pods -n todo` montre des pods de la nouvelle version en `CrashLoopBackOff`

### 6.2 Qui décide

**La personne d'astreinte décide seule et n'a besoin d'aucune validation.** Un retour arrière
prend 3 secondes, ne détruit aucune donnée et se rejoue autant de fois que nécessaire.

### 6.3 Le retour arrière

**Étape 1 — Revenir à la révision précédente**

```sh
kubectl rollout undo deployment/todo-api -n todo
```

**Vérification :** la commande affiche `deployment.apps/todo-api rolled back`.

Si elle affiche `no rollout history found`, c'est qu'aucun déploiement n'a encore eu lieu sur ce
cluster : il n'y a rien à annuler, et la panne est ailleurs — allez au [§7](#7-pannes-connues-et-leur-signature).

**Étape 2 — Attendre la convergence**

```sh
kubectl rollout status deployment/todo-api -n todo --timeout=120s
```

**Vérification :** la commande finit par `deployment "todo-api" successfully rolled out`.

**Étape 3 — Confirmer le rétablissement**

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H "Host: todo.localhost" http://localhost:8080/api/tasks
```

**Vérification :** affiche `200`. Pas `/health` : voir [§7.7](#77-la-limite-de-health-ce-quil-ne-teste-pas).

**Étape 4 — Revenir à une révision plus ancienne, si besoin**

```sh
kubectl rollout history deployment/todo-api -n todo
kubectl rollout undo deployment/todo-api -n todo --to-revision=NUMÉRO
```

**Étape 5 — Empêcher le retour de la panne**

Le prochain push sur `main` **redéploiera la version fautive**. Annulez-la dans le dépôt :

```sh
git revert <identifiant du commit fautif>
git push origin main
```

### 6.4 Déploiement manuel, si la pipeline est en panne

À n'utiliser que si le runner est mort ou GitHub inaccessible.

**Étape 1 — Choisir la version**

```sh
git log --format='%H %s' -5
```

**Vérification :** prenez l'identifiant **complet** (40 caractères) d'une ligne dont l'image existe
sur Docker Hub. Le sha court de `git log --oneline` donne toujours un `ImagePullBackOff`.

**Étape 2 — La poser sur le Deployment**

```sh
kubectl set image deployment/todo-api todo-api=ovbd/todo-api:COLLEZ_ICI_L_IDENTIFIANT -n todo
```

**Vérification :** la commande affiche `deployment.apps/todo-api image updated`.

**Étape 3 — Attendre la convergence, et savoir quoi faire si elle n'arrive pas**

```sh
kubectl rollout status deployment/todo-api -n todo --timeout=120s
```

**Vérification :** `successfully rolled out`. Si la commande finit par `timed out waiting for the
condition`, **la production n'a pas bougé** : les anciens pods tiennent toujours. Allez au
[§7.6](#76-le-rollout-ne-converge-pas).

**Étape 4 — Confirmer**

Étape 5 du [§2](#2-déploiement-normal), les deux commandes.

---

## 7. Pannes connues et leur signature

### Tableau de diagnostic

Lisez ce tableau **de gauche à droite** : `kubectl get pods -n todo` d'abord, il sépare les pannes
en deux familles — celles qui se voient dans l'état des pods, et celle qui ne s'y voit pas.

| `kubectl get pods -n todo` | `/health` | `/api/tasks` | Se répare seule ? | Diagnostic | Aller à |
|---|---|---|---|---|---|
| un pod en moins, puis un neuf en `ContainerCreating` | 200 | 200 | **oui, ~30 s** | un pod a été supprimé | [§7.4](#74-un-pod-a-disparu-ou-son-processus-est-mort) |
| un pod `0/1 Running`, colonne `RESTARTS` à 1 | 200 | 200 | **oui, ~25 s** | le processus est mort dans le conteneur | [§7.4](#74-un-pod-a-disparu-ou-son-processus-est-mort) |
| un pod `0/1 ImagePullBackOff`, les anciens `1/1 Running` | 200 | 200 | non | le tag d'image n'existe pas | [§7.5](#75-imagepullbackoff-le-tag-nexiste-pas) |
| un pod `0/1 CrashLoopBackOff`, `RESTARTS` qui grimpe | 200 | 200 | non | `limits.memory` trop basse, ou l'app plante au démarrage | [§7.8](#78-crashloopbackoff-et-oomkilled) |
| **trois pods `1/1 Running`, rien d'anormal** | **200** | **500 en ~20 ms** | **non** | **configuration cassée — la seule panne invisible** | [§7.9](#79-tout-est-vert-et-apitasks-repond-500) |
| trois pods `1/1 Running`, `todo-db` absent | 200 | **500 après ~21 s** | non | la base est injoignable | [§7.10](#710-la-base-est-injoignable) |

**La ligne en gras est la seule qui coupe réellement le service.** Les quatre premières laissent
l'API répondre : trois copies tournent, le Service route vers celles qui vont bien, et
`maxUnavailable: 0` empêche un déploiement cassé de retirer une seule copie saine.

**Le temps de réponse du 500 sépare les deux dernières lignes** : ~20 ms veut dire « la base
refuse » (mauvais mot de passe, configuration cassée), ~21 s veut dire « la base ne répond pas du
tout » (pod absent, Service sans endpoint).

Deux commandes valent pour toutes les sections ci-dessous :

```sh
kubectl describe pod -n todo NOM_DU_POD        # section Events, tout en bas
kubectl logs -n todo NOM_DU_POD --previous     # les logs d'AVANT le dernier redémarrage
```

`describe` raconte ce que le cluster a tenté ; `logs --previous` raconte ce que l'application a
fait avant de tomber. Sans `--previous`, vous lisez les logs du conteneur tout juste relancé,
encore vides.

### 7.1 `kubectl` ne répond pas, ou pointe ailleurs

**Signature :** `The connection to the server ... was refused`, ou bien `kubectl get pods -n todo`
répond `No resources found` alors que le service tourne.

```sh
kubectl config current-context
```

**Vérification :** affiche `k3d-todo-cluster`. **Si ce n'est pas le cas, tout ce que vous avez lu
jusqu'ici concernait un autre cluster.**

```sh
kubectl config use-context k3d-todo-cluster
```

Si le contexte n'existe pas, ou si la connexion est refusée, le cluster est éteint :

```sh
k3d cluster list
k3d cluster start todo-cluster
```

**Vérification :** attendez ~30 s, `kubectl get nodes` affiche un node `Ready`.

### 7.2 Le job `deploy` reste en `Queued`

Le runner est éteint. Aucun message d'erreur : le job attend, c'est tout.

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

### 7.4 Un pod a disparu, ou son processus est mort

**Signature :** soit un pod en moins et un neuf qui démarre, soit un pod `0/1 Running` dont la
colonne `RESTARTS` vient d'augmenter. Dans les deux cas, `/api/tasks` répond `200` tout du long.

**Il n'y a rien à faire.** Le cluster a déjà commencé à réparer avant que vous ne lisiez cette
ligne. Mesuré sur ce cluster : pod recréé et `1/1 Running` en **~30 s**, conteneur redémarré en
**~25 s**.

```sh
kubectl get pods -n todo -w        # Ctrl-C pour sortir
```

**Vérification :** au bout d'une minute, trois pods `1/1 Running` et la colonne `RESTARTS` cesse
d'augmenter.

**Si elle continue d'augmenter**, ce n'est pas cette section : le conteneur ne meurt pas une fois
mais en boucle, allez au [§7.8](#78-crashloopbackoff-et-oomkilled).

### 7.5 `ImagePullBackOff` : le tag n'existe pas

**Signature :** un pod `0/1 ImagePullBackOff` ou `ErrImagePull`, **les anciens pods toujours
`1/1 Running`**, et `/api/tasks` qui répond `200`.

```sh
kubectl describe pod -n todo NOM_DU_POD | grep -A6 "^Events:"
```

**Vérification :** un événement `Failed to pull image ... not found`. Le nom exact de l'image
manquante y est écrit en toutes lettres.

Cause presque toujours la même : un sha court collé à la place du sha complet, ou une faute de
frappe. Le cluster réessaiera indéfiniment sans jamais y arriver.

```sh
kubectl rollout undo deployment/todo-api -n todo
```

**Vérification :** le pod fautif disparaît en **~1 s**, et `kubectl get pods -n todo` ne montre
plus que trois pods `1/1 Running`.

### 7.6 Le rollout ne converge pas

**Signature :** `kubectl rollout status` finit par `timed out waiting for the condition`, ou le
job `deploy` est rouge à cette étape.

**La production n'a pas bougé.** Le nouveau pod n'est jamais devenu prêt, donc aucun ancien n'a
été retiré. Vous avez le temps de comprendre avant d'agir.

```sh
kubectl get pods -n todo -l app=todo-api
```

Regardez l'état du pod qui n'arrive pas à démarrer et suivez la ligne correspondante du tableau :
`ImagePullBackOff` → [§7.5](#75-imagepullbackoff-le-tag-nexiste-pas), `CrashLoopBackOff` →
[§7.8](#78-crashloopbackoff-et-oomkilled), `Pending` → [§7.11](#711-un-pod-reste-pending).

Un pod bloqué en `0/1 Running` sans redémarrage est un troisième cas : sa readiness probe échoue.

```sh
kubectl describe pod -n todo NOM_DU_POD | grep -i unhealthy
```

**Vérification :** un événement `Readiness probe failed: ... connection refused` nomme le port
interrogé. S'il ne vaut pas `3000`, la sonde du manifeste vise un port que le conteneur n'expose
pas.

Dans tous les cas, `kubectl rollout undo deployment/todo-api -n todo` remet le Deployment dans
l'état d'avant et fait disparaître le pod bloqué.

### 7.7 La limite de `/health` : ce qu'il ne teste pas

**À lire avant tout diagnostic.** `/health` répond `{"status":"ok"}` **sans jamais interroger la
base de données**. Il prouve une seule chose : le serveur HTTP écoute.

Les deux sondes du Deployment, `readinessProbe` et `livenessProbe`, sont bâties dessus. Elles
mentent donc exactement de la même façon.

Mesuré sur ce cluster, base coupée (`kubectl scale deployment/todo-db -n todo --replicas=0`) :

| | Ce que ça donne |
|---|---|
| `kubectl get pods` | trois pods `1/1 Running`, aucun redémarrage |
| événements `Unhealthy` | **aucun** |
| `/health` | **200 en 6 ms** |
| `/api/tasks` | **500 après 21 s** |

**Ne concluez jamais « ça va » sur un `/health` à 200.** Le seul contrôle qui engage quelque chose
est `curl … /api/tasks`, et c'est pour cela qu'il figure à l'étape 5 du
[§2](#2-déploiement-normal) et à l'étape 3 du [§6.3](#63-le-retour-arrière).

### 7.8 `CrashLoopBackOff` et `OOMKilled`

**Signature :** un pod `0/1 CrashLoopBackOff`, colonne `RESTARTS` qui grimpe régulièrement.

```sh
kubectl describe pod -n todo NOM_DU_POD | grep -A4 "Last State"
```

**Vérification :** la section `Last State` nomme la cause.

- `Reason: OOMKilled`, `Exit Code: 137` → le conteneur a dépassé sa `limits.memory`. Mesuré sur
  ce cluster : l'API consomme **42 à 48 Mi**, `40Mi` la tue au démarrage, la limite versionnée est
  `64Mi`. Si quelqu'un l'a abaissée, remettez-la :

  ```sh
  kubectl apply -f k8s/todo-api-deployment.yaml
  ```

- `Reason: Error`, un autre code de sortie → l'application plante d'elle-même. Lisez pourquoi :

  ```sh
  kubectl logs -n todo NOM_DU_POD --previous
  ```

  Puis **retour arrière** ([§6](#6-retour-arrière)).

**Vérification :** le pod fautif disparaît, trois pods `1/1 Running` restent.

### 7.9 Tout est vert et `/api/tasks` répond 500

**Signature :** trois pods `1/1 Running`, zéro redémarrage, aucun événement anormal dans
`describe`, `/health` à 200 — **et `/api/tasks` qui répond 500 en ~20 ms**.

**C'est la seule panne de ce document que le cluster ne signale nulle part**, et la seule qui
coupe le service pour tout le monde. Elle survient quand une clé disparaît du `ConfigMap` ou du
`Secret` : le pod démarre sans elle, l'application se rabat sur une valeur par défaut, et la base
refuse la connexion.

La cause n'est visible que dans les logs applicatifs :

```sh
kubectl logs -n todo -l app=todo-api --tail=5
```

**Vérification :** une ligne du type `migration : tentative 3/10 echouee (password authentication
failed for user "todo")`. Elle nomme la variable en cause.

Comparez ce que le pod a reçu avec ce que le dépôt déclare :

```sh
kubectl get secret todo-secret -n todo -o jsonpath='{.data}' | tr ',' '\n'
kubectl get configmap todo-config -n todo -o jsonpath='{.data}' | tr ',' '\n'
```

**Vérification :** le Secret doit contenir `DB_NAME`, `DB_USER` et `DB_PASSWORD` ; le ConfigMap
`DB_HOST`, `DB_PORT`, `NODE_ENV` et `PORT`. Une clé manquante est la panne.

Remède — réappliquer, **puis relancer les pods** : un objet modifié ne pousse rien tout seul vers
un pod déjà vivant.

```sh
kubectl apply -f k8s/todo-secret.yaml
kubectl apply -f k8s/todo-config.yaml
kubectl rollout restart deployment/todo-api -n todo
kubectl rollout status deployment/todo-api -n todo --timeout=120s
```

**Vérification :** `/api/tasks` répond `200`. Mesuré : **23 s** entre le `apply` et le
rétablissement.

> Si `k8s/todo-secret.yaml` n'existe pas sur votre poste, il n'est pas versionné : recréez-le
> depuis `docs/todo-secret.example.yaml` avec le mot de passe de l'équipe. Attention, le changer
> ne suffit pas : la base a été créée avec l'ancien, elle continuera de le réclamer.

### 7.10 La base est injoignable

**Signature :** `/health` à 200, `/api/tasks` à **500 après ~21 s**, et le pod `todo-db` absent ou
non `Running`.

```sh
kubectl get pods -n todo -l app=todo-db
kubectl get endpoints todo-db -n todo
```

**Vérification :** si la colonne `ENDPOINTS` affiche `<none>` alors que le pod tourne, ce n'est pas
la base qui est morte, c'est le `selector` du Service qui ne cible plus aucun pod.

- pod absent (quelqu'un a fait `scale --replicas=0`) :

  ```sh
  kubectl scale deployment/todo-db -n todo --replicas=1
  ```

- `ENDPOINTS` à `<none>` avec un pod `Running` :

  ```sh
  kubectl apply -f k8s/todo-db.yaml
  ```

**Vérification :** `/api/tasks` répond `200` en moins d'une seconde.

### 7.11 Un pod reste `Pending`

**Signature :** un pod `0/1 Pending` qui n'avance pas, sans redémarrage.

```sh
kubectl describe pod -n todo NOM_DU_POD | grep -A4 "^Events:"
```

Deux messages possibles, deux causes très différentes :

- `Insufficient memory` / `Insufficient cpu` → le node n'a plus de place. Libérez-en, ou baissez
  la `requests` du manifeste.
- `persistentvolumeclaim "todo-db-data" is being deleted` → **quelqu'un a lancé un
  `kubectl delete pvc` que le finalizer retient**. Tant que le pod vivait, rien ne se voyait ; il
  disparaît au premier redémarrage et rien ne le remplace. La PVC ne peut pas être « dé-supprimée » :

  ```sh
  kubectl delete deployment todo-db -n todo
  kubectl apply -f k8s/todo-db.yaml
  ```

  **Les données de la base sont perdues** — c'est le seul cas de ce document où c'est vrai.

**Vérification :** `kubectl get pvc -n todo` affiche `todo-db-data Bound`, et le pod passe
`1/1 Running`.

---

## 8. Ce que cette procédure ne couvre pas

Dites-le plutôt que de laisser chercher :

- **restaurer les données** de la base après une perte : aucune sauvegarde n'est en place. La PVC
  `todo-db-data` survit à la destruction du pod, mais rien ne survit à sa suppression.
- **surveiller autrement qu'à la main** : Prometheus et Grafana ne scrapent plus la production
  depuis qu'elle tourne dans le cluster. Il n'y a plus d'alerte, seulement les commandes de ce
  document.
- **un cluster à plusieurs nodes** : la PVC est en `ReadWriteOnce` sur un stockage local, elle ne
  voyage pas d'une machine à l'autre.
- **changer le mot de passe de la base** : modifier le Secret ne change pas celui que PostgreSQL a
  enregistré à sa création.
