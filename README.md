# Prototype Planning Grangettes

Prototype léger sur une seule page pour gérer les inscriptions aux permanences.

## Fonctionnalités

- Affiche un tableau partagé de type feuille de calcul
- Permet de choisir un membre puis de l'inscrire ou de le retirer d'un créneau `Matin` / `Après-midi`
- Permet a chaque membre de se connecter avec son code d'acces personnel
- Limite l'edition des creneaux a la personne connectee
- Permet de modifier la liste des membres et les dates depuis une zone d'administration protégée
- Ajoute un journal d'audit des changements cote administration
- Ajoute une colonne de commentaires libres par date
- Utilise une session administrateur par cookie HTTP et un mot de passe haché
- Recharge automatiquement le planning toutes les quelques secondes
- Stocke l'etat partage dans une base SQLite locale

## Lancement local

```bash
npm install
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

Cette version utilise `better-sqlite3`, donc un `npm install` est necessaire sur la machine de deploiement.

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
- `data/schedule.json` : planning seed/de demonstration conserve dans git
- `data/grangettes.sqlite` : base SQLite runtime creee automatiquement et ignoree par git

## Persistance des données

Pour l'instant :

- `data/schedule.json` sert de base propre a versionner
- `data/config.json` contient le titre versionne
- `data/grangettes.sqlite` recoit les vraies modifications a l'execution

Au premier demarrage, la base SQLite est initialisee depuis les fichiers JSON existants. Si `data/schedule.local.json` existe encore, il sert de source de migration unique avant que SQLite devienne le stockage principal.

Ce choix est bien adapte a un petit prototype sur VPS et prepare mieux les prochaines etapes comme l'authentification membre et le journal d'audit.
