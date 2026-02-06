const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Sert les fichiers (index.html, images, etc.)
app.use(express.static(__dirname));
app.use(express.json());

// --- BASE DE DONNÉES (Sauvegarde les salons) ---
let db = { groupes: {} };

// Chargement de la sauvegarde si elle existe
if (fs.existsSync('database.json')) {
    try {
        const data = fs.readFileSync('database.json');
        db = JSON.parse(data);
    } catch (e) {
        console.log("Création d'une nouvelle base de données.");
    }
}

function sauvegarder() {
    fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
}

// Fonction pour envoyer la liste des salons à tout le monde
function diffuserSalons() {
    const liste = Object.keys(db.groupes).map(nom => ({
        nom, 
        owner: db.groupes[nom].ownerUID,
        membres: Object.keys(db.groupes[nom].membres).length,
        max: db.groupes[nom].limiteUsers,
        totalMessages: db.groupes[nom].messages.length // Sert pour les badges de notif
    }));
    io.emit('liste_salons', liste);
}

io.on('connection', (socket) => {
    // Dès qu'on arrive, on reçoit la liste
    diffuserSalons();

    // --- REJOINDRE OU CRÉER UN GROUPE ---
    socket.on('join_group', (data) => {
        const { nom, mdp, maxUsers, estCreation, userUID } = data;
        socket.userUID = userUID; 
        
        // 1. CRÉATION
        if (estCreation) {
            // Si le nom existe déjà et appartient à quelqu'un d'autre
            if (db.groupes[nom] && db.groupes[nom].ownerUID !== userUID) {
                 return socket.emit('erreur', "Ce nom de salon est déjà pris par quelqu'un d'autre.");
            }

            // On crée ou on écrase (si c'est le même owner)
            db.groupes[nom] = { 
                motDePasse: mdp, 
                limiteUsers: parseInt(maxUsers) || 50, 
                ownerUID: userUID, 
                messages: [], 
                membres: {}, 
                dernierNumero: 0 
            };
            sauvegarder();
            diffuserSalons();
        }

        // 2. VÉRIFICATIONS
        const g = db.groupes[nom];
        if (!g) return socket.emit('erreur', "Ce salon n'existe pas.");
        if (g.motDePasse !== mdp) return socket.emit('erreur', "Code secret incorrect.");
        
        const nbActuel = Object.keys(g.membres).length;
        if (!g.membres[userUID] && nbActuel >= g.limiteUsers) return socket.emit('erreur', "Le salon est complet.");

        // 3. ENTRÉE DANS LE SALON
        socket.join(nom);
        socket.nomGroupe = nom;
        
        // Attribution d'un pseudo (Membre #01, #02...)
        if (!g.membres[userUID]) {
            g.dernierNumero++;
            g.membres[userUID] = g.dernierNumero;
            sauvegarder();
            diffuserSalons(); // Pour mettre à jour le compteur de membres
        }
        
        // Formatage du pseudo (ex: "Membre #05")
        let num = g.membres[userUID];
        socket.pseudo = "Membre #" + (num < 10 ? "0" + num : num);
        
        // Envoi des infos au client pour afficher le chat
        socket.emit('bienvenue', { 
            nom, 
            historique: g.messages, 
            monPseudo: socket.pseudo, 
            owner: g.ownerUID, 
            nbMembres: Object.keys(g.membres).length, 
            max: g.limiteUsers 
        });
    });

    // --- SUPPRESSION DU SALON ---
    socket.on('supprimer_salon', (nom) => {
        // Seul le créateur peut supprimer
        if (db.groupes[nom] && db.groupes[nom].ownerUID === socket.userUID) {
            delete db.groupes[nom];
            sauvegarder();
            diffuserSalons();
            io.to(nom).emit('salon_supprime'); // Prévient les gens dedans
        }
    });

    // --- ENVOI DE MESSAGE ---
    socket.on('envoi_message', (txt) => {
        const g = db.groupes[socket.nomGroupe];
        if (g) {
            const m = { texte: txt, auteur: socket.pseudo, date: Date.now() };
            g.messages.push(m);
            
            // On garde seulement les 50 derniers messages pour ne pas surcharger la base
            if(g.messages.length > 50) g.messages.shift();
            
            sauvegarder();
            io.to(socket.nomGroupe).emit('nouveau_message', m);
            diffuserSalons(); // Pour les notifs de nouveaux messages
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Serveur AnonymatChat démarré sur le port ${PORT}`);
});
