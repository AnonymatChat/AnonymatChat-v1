const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));
app.use(express.json());

// --- CONFIGURATION KKIAPAY ---
// Remplace par ta 'Private API Key' (Trouvée dans ton dashboard Kkiapay)
const KKIAPAY_PRIVATE_KEY = 'tpk_79ba7f3002a911f19f19c5c8b76e4490'; 

// --- BASE DE DONNÉES ---
let db = { groupes: {}, inventaire: {} };
if (fs.existsSync('database.json')) {
    db = JSON.parse(fs.readFileSync('database.json'));
}

function sauvegarder() {
    fs.writeFileSync('database.json', JSON.stringify(db, null, 2));
}

// --- AUTOMATE DE PAIEMENT (WEBHOOK) ---
app.post('/api/kkiapay-callback', (req, res) => {
    try {
        // On récupère les infos envoyées par le bouton (UID, type, qte)
        const info = JSON.parse(req.body.data); 
        const uid = info.uid;

        if (!db.inventaire[uid]) db.inventaire[uid] = { groupesSupp: 0, usersSupp: 0 };

        if (info.type === "groupe") {
            db.inventaire[uid].groupesSupp += parseInt(info.qte);
        } else if (info.type === "user") {
            db.inventaire[uid].usersSupp += parseInt(info.qte);
        }

        sauvegarder();
        console.log(`💰 PAIEMENT VALIDÉ : +${info.qte} ${info.type} pour ${uid}`);
        res.json({ status: "success" });
    } catch (e) {
        console.error("Erreur Webhook:", e);
        res.status(400).send("Erreur");
    }
});

// --- LOGIQUE DU CHAT ---
io.on('connection', (socket) => {
    socket.on('join_group', (data) => {
        const { nom, mdp, maxUsers, estCreation, userUID } = data;
        const inv = db.inventaire[userUID] || { groupesSupp: 0, usersSupp: 0 };
        
        const limiteGroupes = 1 + inv.groupesSupp;
        const limiteUsersTotal = 10 + inv.usersSupp;

        if (estCreation) {
            const mesGroupes = Object.values(db.groupes).filter(g => g.ownerUID === userUID).length;
            if (mesGroupes >= limiteGroupes) {
                return socket.emit('erreur', `Limite: ${limiteGroupes} salon. Achète un pack !`);
            }
            if (parseInt(maxUsers) > limiteUsersTotal) {
                return socket.emit('erreur', `Max membres: ${limiteUsersTotal}. Achète un pack !`);
            }
            
            db.groupes[nom] = { 
                motDePasse: mdp, 
                limiteUsers: parseInt(maxUsers), 
                ownerUID: userUID, 
                messages: [], 
                membres: {},
                dernierNumero: 0
            };
            sauvegarder();
        }

        if (!db.groupes[nom]) return socket.emit('erreur', 'Salon introuvable.');
        if (db.groupes[nom].motDePasse !== mdp) return socket.emit('erreur', 'Code faux.');

        socket.join(nom);
        socket.nomGroupe = nom;
        socket.userUID = userUID;
        
        const g = db.groupes[nom];
        if (!g.membres[userUID]) {
            g.dernierNumero++;
            g.membres[userUID] = g.dernierNumero;
            sauvegarder();
        }
        
        socket.pseudo = "Membre #" + (g.membres[userUID] < 10 ? "0"+g.membres[userUID] : g.membres[userUID]);
        socket.emit('bienvenue', { nom, historique: g.messages, monPseudo: socket.pseudo });
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
server.listen(PORT, () => console.log(`🚀 Lancé sur http://localhost:${PORT}`));
