# Prototype Planning Grangettes

Prototype léger sur une seule page pour gérer les inscriptions aux permanences.

## Fonctionnalités

- Affiche un tableau partagé de type feuille de calcul
- Permet de choisir un membre puis de l'inscrire ou de le retirer d'un créneau `Matin` / `Après-midi`
- Permet de modifier la liste des membres et les dates depuis une zone d'administration protégée
- Ajoute une colonne de commentaires libres par date
- Utilise une session administrateur par cookie HTTP et un mot de passe haché
- Recharge automatiquement le planning toutes les quelques secondes
- Stocke l'état partagé dans un fichier JSON local

## Lancement local

```bash
npm start
```

Puis ouvrez [http://localhost:3000](http://localhost:3000).

## Déploiement VPS

Pour un hébergement Node.js comme alwaysdata :

```bash
Commande : node server.js
```

Variables d'environnement recommandées :

```bash
NODEJS_VERSION=20
HOST=::
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH='scrypt$...'
```

Un endpoint de vérification simple est disponible sur `/health`.

## Administration

Par défaut, l'administration utilise :

- identifiant : `admin`
- mot de passe : `grangettes`

Pour un vrai déploiement, créez un hash avec :

```bash
npm run hash-password -- "votre-mot-de-passe"
```

Puis lancez l'application avec :

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD_HASH='scrypt$...' npm start
```

L'interface d'administration utilise ensuite une session par cookie HTTP-only.

## Renommage des membres

Un renommage simple comme `Alice` vers `Alice Johnson` conserve désormais l'identité interne du membre et donc ses créneaux existants.

Note importante : cette conservation se fait par position dans la liste d'administration. Si vous réordonnez fortement la liste ou fusionnez plusieurs noms en même temps, il faut vérifier le résultat.

## Pourquoi ce choix

- Pas de base de données
- Aucun paquet npm externe
- Adapté à un petit VPS
- Facile à faire évoluer ensuite vers une authentification, une administration plus fine ou un export

## Fichiers principaux

- `server.js` : petit serveur HTTP et API JSON
- `public/` : interface web en une page
- `data/config.json` : configuration simple, dont le titre du tableau
- `data/schedule.json` : planning seed/de démonstration conservé dans git
- `data/schedule.local.json` : planning runtime local, créé automatiquement et ignoré par git

## Persistance des données

Pour l'instant :

- `data/schedule.json` sert de base propre à versionner
- `data/schedule.local.json` reçoit les vraies modifications à l'exécution

Ce choix est bien adapté à un petit prototype sur VPS. Si le projet devient plus important, SQLite sera probablement la meilleure étape suivante.

Au démarrage, si `data/schedule.local.json` est absent ou invalide, il est automatiquement recréé à partir de `data/schedule.json`.
