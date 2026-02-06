const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));
app.use(express.json());

let db = { groupes: {} };

if (fs.existsSync('database.json')) {
    try {
        db = JSON.parse(fs.readFileSync('database.json'));
    } catch (e) { console.log("Nouvelle DB"); }
}

function sauvegarder() {
    fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
}

function diffuserSalons() {
    const liste = Object.keys(db.groupes).map(nom => ({
        nom, 
        owner: db.groupes[nom].ownerUID,
        membres: Object.keys(db.groupes[nom].membres).length,
        max: db.groupes[nom].limiteUsers,
        totalMessages: db.groupes[nom].messages.length
    }));
    io.emit('liste_salons', liste);
}

io.on('connection', (socket) => {
    diffuserSalons();

    socket.on('join_group', (data) => {
        const { nom, mdp, maxUsers, estCreation, userUID } = data;
        socket.userUID = userUID; 
        
        if (estCreation) {
            if (db.groupes[nom] && db.groupes[nom].ownerUID !== userUID) {
                 return socket.emit('erreur', "Ce nom de salon est déjà pris.");
            }
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

        const g = db.groupes[nom];
        if (!g) return socket.emit('erreur', "Salon introuvable.");
        if (g.motDePasse !== mdp) return socket.emit('erreur', "Code secret incorrect.");
        
        if (!g.membres[userUID] && Object.keys(g.membres).length >= g.limiteUsers) {
            return socket.emit('erreur', "Salon complet.");
        }

        socket.join(nom);
        socket.nomGroupe = nom;
        
        if (!g.membres[userUID]) {
            g.dernierNumero++;
            g.membres[userUID] = g.dernierNumero;
            sauvegarder();
            diffuserSalons();
        }
        
        let num = g.membres[userUID];
        socket.pseudo = "Membre #" + (num < 10 ? "0" + num : num);
        
        socket.emit('bienvenue', { 
            nom, 
            historique: g.messages, 
            monPseudo: socket.pseudo, 
            owner: g.ownerUID, 
            nbMembres: Object.keys(g.membres).length, 
            max: g.limiteUsers 
        });
    });

    socket.on('supprimer_salon', (nom) => {
        if (db.groupes[nom] && db.groupes[nom].ownerUID === socket.userUID) {
            delete db.groupes[nom];
            sauvegarder();
            diffuserSalons();
            io.to(nom).emit('salon_supprime');
        }
    });

    socket.on('envoi_message', (txt) => {
        const g = db.groupes[socket.nomGroupe];
        if (g) {
            const m = { texte: txt, auteur: socket.pseudo, date: Date.now() };
            g.messages.push(m);
            if(g.messages.length > 100) g.messages.shift();
            sauvegarder();
            io.to(socket.nomGroupe).emit('nouveau_message', m);
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Serveur actif sur port ${PORT}`));
