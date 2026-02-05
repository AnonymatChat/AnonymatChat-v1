const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));
app.use(express.json());

const KKIAPAY_PRIVATE_KEY = 'pk_cdcea52e7f28e5e44cb8c7faaebff4233dfa7dae4e51b14dd37c04449da404fe'; 

let db = { groupes: {}, inventaire: {} };
if (fs.existsSync('database.json')) db = JSON.parse(fs.readFileSync('database.json'));

function sauvegarder() { fs.writeFileSync('database.json', JSON.stringify(db, null, 2)); }

function diffuserSalons() {
    const liste = Object.keys(db.groupes).map(nom => ({
        nom: nom,
        owner: db.groupes[nom].ownerUID,
        membres: Object.keys(db.groupes[nom].membres).length,
        max: db.groupes[nom].limiteUsers
    }));
    io.emit('liste_salons', liste);
}

app.post('/api/kkiapay-callback', (req, res) => {
    try {
        const info = JSON.parse(req.body.data); 
        const uid = info.uid;
        if (!db.inventaire[uid]) db.inventaire[uid] = { groupesSupp: 0, usersSupp: 0 };
        if (info.type === "groupe") db.inventaire[uid].groupesSupp += parseInt(info.qte);
        else if (info.type === "user") db.inventaire[uid].usersSupp += parseInt(info.qte);
        sauvegarder();
        res.json({ status: "success" });
    } catch (e) { res.status(400).send("Erreur"); }
});

io.on('connection', (socket) => {
    diffuserSalons();

    socket.on('join_group', (data) => {
        const { nom, mdp, maxUsers, estCreation, userUID } = data;
        socket.userUID = userUID; 
        const inv = db.inventaire[userUID] || { groupesSupp: 0, usersSupp: 0 };
        
        if (estCreation) {
            const mesGroupes = Object.values(db.groupes).filter(g => g.ownerUID === userUID).length;
            if (mesGroupes >= (1 + inv.groupesSupp)) return socket.emit('erreur', "Limite de salons atteinte.");
            
            db.groupes[nom] = { 
                motDePasse: mdp, 
                limiteUsers: parseInt(maxUsers), 
                ownerUID: userUID, 
                messages: [], 
                membres: {}, 
                dernierNumero: 0 
            };
            sauvegarder();
            diffuserSalons();
        }

        const g = db.groupes[nom];
        if (!g || g.motDePasse !== mdp) return socket.emit('erreur', "Accès refusé ou code faux.");

        // --- CORRECTION : VÉRIFICATION DE LA LIMITE ---
        const nbActuel = Object.keys(g.membres).length;
        if (!g.membres[userUID] && nbActuel >= g.limiteUsers) {
            return socket.emit('erreur', "Ce salon est complet (" + g.limiteUsers + " max).");
        }

        socket.join(nom);
        socket.nomGroupe = nom;
        if (!g.membres[userUID]) {
            g.dernierNumero++;
            g.membres[userUID] = g.dernierNumero;
            sauvegarder();
            diffuserSalons(); // Update la liste pour les autres
        }
        socket.pseudo = "Membre #" + (g.membres[userUID] < 10 ? "0"+g.membres[userUID] : g.membres[userUID]);
        
        // On envoie le nombre de membres actuel
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
            sauvegarder();
            io.to(socket.nomGroupe).emit('nouveau_message', m);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Port ${PORT}`));
