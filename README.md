# Prototype Planning Grangettes

Prototype léger sur une seule page pour gérer les inscriptions aux permanences.

## Fonctionnalités

- Affiche un tableau partagé de type feuille de calcul
- Permet de choisir un membre puis de l'inscrire ou de le retirer d'un créneau `Matin` / `Après-midi`
- Permet de modifier la liste des membres depuis l'interface
- Permet de modifier les dates affichées depuis l'interface
- Ajoute une colonne de commentaires libres par date
- Stocke l'état partagé dans un fichier JSON local

## Lancement local

```bash
npm start
```

Puis ouvrez [http://localhost:3000](http://localhost:3000).

## Pourquoi ce choix

- Pas de base de données
- Aucun paquet npm externe
- Adapté à un petit VPS
- Facile à faire évoluer ensuite vers une authentification, une administration plus fine ou un export

## Fichiers principaux

- `server.js` : petit serveur HTTP et API JSON
- `public/` : interface web en une page
- `data/schedule.json` : planning partagé persistant, créé automatiquement au premier lancement
