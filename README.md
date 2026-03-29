# Prototype Planning Grangettes

Prototype léger sur une seule page pour gérer les inscriptions aux permanences.

## Fonctionnalités

- Affiche un tableau partagé de type feuille de calcul
- Permet de choisir un membre puis de l'inscrire ou de le retirer d'un créneau `Matin` / `Après-midi`
- Permet de modifier la liste des membres et les dates depuis une zone d'administration protégée
- Ajoute une colonne de commentaires libres par date
- Utilise une session administrateur par cookie HTTP et un mot de passe haché
- Stocke l'état partagé dans un fichier JSON local

## Lancement local

```bash
npm start
```

Puis ouvrez [http://localhost:3000](http://localhost:3000).

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
- `data/schedule.json` : planning partagé persistant, créé automatiquement au premier lancement
