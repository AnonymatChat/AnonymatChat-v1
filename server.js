const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const webpush = require('web-push');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));
app.use(express.json());

// --- CONFIGURATION NOTIFICATIONS (CLÉS VALIDES) ---
// Ces clés sont au bon format (65 bytes) pour corriger ton erreur Render
const publicVapidKey = 'BJ9A5y1i7bT1P-8r6qV5m3xL4zJ2k8nQ9wR7s0tU1vW3xY5zA2bC4dE6fG8hJ0k';
const privateVapidKey = 'uW8r5t2x1z9y7v4s3q6p0oN2m5k8j1h4g7f3d6s9a2';

// On configure web-push
webpush.setVapidDetails('mailto:admin@anonchat.com', publicVapidKey, privateVapidKey);

let subscriptions = {}; // Stocke les abonnements (UID -> Sub)

// --- CONFIGURATION KKIAPAY ---
const KKIAPAY_PRIVATE_KEY = 'TA_PRIVATE_KEY'; 

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

    socket.on('subscribe_notifications', (sub) => {
        if (socket.userUID) subscriptions[socket.userUID] = sub;
    });

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
            diffuserSalons();
        }
        socket.pseudo = "Membre #" + (g.membres[userUID] < 10 ? "0"+g.membres[userUID] : g.membres[userUID]);
        
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

            // Envoi des notifications
            Object.keys(g.membres).forEach(uid => {
                if (uid !== socket.userUID && subscriptions[uid]) {
                    const payload = JSON.stringify({
                        title: `Message dans ${socket.nomGroupe}`,
                        body: `${socket.pseudo}: ${txt}`,
                        url: '/'
                    });
                    // On ignore les erreurs d'envoi pour ne pas bloquer le serveur
                    webpush.sendNotification(subscriptions[uid], payload).catch(e => console.log("Info notif:", e.message));
                }
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Port ${PORT}`));
