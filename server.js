const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const axios = require('axios');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));
app.use(express.json());

// --- CONFIG PAYPAL ---
const PAYPAL_CLIENT_ID = 'AQGOfxfUa8EjnGe01WnolvW78AS9HTJFZgsugBEudbggkiBuNr5M1Xo2GJ5EVYwB-fNyGmad0asygMOA';
const PAYPAL_SECRET = 'ENIrSILX_PRGe6JtMO8ciNFehfzlNpYmqZW1mnacM09OIka9wOU5cA59lIJ65jGZgino1obgJ7Ijw9N2';
const PAYPAL_API = 'https://api-m.sandbox.paypal.com'; // Change en 'api-m.paypal.com' pour le mode RÉEL

let db = { groupes: {}, inventaire: {} };
if (fs.existsSync('database.json')) db = JSON.parse(fs.readFileSync('database.json'));

function sauvegarder() { fs.writeFileSync('database.json', JSON.stringify(db, null, 2)); }

// Fonction pour récupérer un jeton PayPal
async function getPayPalToken() {
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
    const res = await axios.post(`${PAYPAL_API}/v1/oauth2/token`, 'grant_type=client_credentials', {
        headers: { Authorization: `Basic ${auth}` }
    });
    return res.data.access_token;
}

// --- WEBHOOK PAYPAL ---
app.post('/paypal-webhook', async (req, res) => {
    const event = req.body;
    // On écoute uniquement quand un paiement est capturé avec succès
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
        const resource = event.resource;
        const customData = JSON.parse(resource.custom_id || "{}"); // On récupère l'UID et le type d'achat
        
        if (customData.uid) {
            if (!db.inventaire[customData.uid]) db.inventaire[customData.uid] = { salons: 1, users: 10 };
            
            // Logique d'ajout selon le montant ou la description
            if (customData.item === 'salon') db.inventaire[customData.uid].salons += customData.qte;
            if (customData.item === 'user') db.inventaire[customData.uid].users += customData.qte;
            
            sauvegarder();
            console.log(`✅ Crédits ajoutés pour ${customData.uid}`);
        }
    }
    res.sendStatus(200);
});

function diffuserSalons() {
    const liste = Object.keys(db.groupes).map(nom => ({
        nom, owner: db.groupes[nom].ownerUID,
        membres: Object.keys(db.groupes[nom].membres).length,
        max: db.groupes[nom].limiteUsers,
        totalMessages: db.groupes[nom].messages.length
    }));
    io.emit('liste_salons', liste);
}

io.on('connection', (socket) => {
    diffuserSalons();

    socket.on('get_credits', (uid) => {
        if (!db.inventaire[uid]) db.inventaire[uid] = { salons: 1, users: 10 };
        socket.emit('update_credits', db.inventaire[uid]);
    });

    socket.on('join_group', (data) => {
        const { nom, mdp, maxUsers, estCreation, userUID } = data;
        if (!db.inventaire[userUID]) db.inventaire[userUID] = { salons: 1, users: 10 };
        const inv = db.inventaire[userUID];

        if (estCreation) {
            // Vérification du Pool
            if (inv.salons < 1) return socket.emit('erreur', "Plus de crédit 'Salon' disponible.");
            if (inv.users < maxUsers) return socket.emit('erreur', `Pas assez de crédit 'Utilisateurs' (${inv.users} restants).`);

            db.groupes[nom] = { 
                motDePasse: mdp, limiteUsers: parseInt(maxUsers), ownerUID: userUID, 
                messages: [], membres: {}, dernierNumero: 0 
            };
            
            // Déduction du Pool
            inv.salons -= 1;
            inv.users -= maxUsers;
            sauvegarder();
            socket.emit('update_credits', inv);
            diffuserSalons();
        }

        const g = db.groupes[nom];
        if (!g || g.motDePasse !== mdp) return socket.emit('erreur', "Code incorrect.");
        if (!g.membres[userUID] && Object.keys(g.membres).length >= g.limiteUsers) return socket.emit('erreur', "Salon complet.");

        socket.join(nom);
        socket.nomGroupe = nom;
        if (!g.membres[userUID]) {
            g.dernierNumero++;
            g.membres[userUID] = g.dernierNumero;
            sauvegarder();
            diffuserSalons();
        }
        socket.pseudo = "Membre #" + (g.membres[userUID] < 10 ? "0"+g.membres[userUID] : g.membres[userUID]);
        socket.emit('bienvenue', { nom, historique: g.messages, monPseudo: socket.pseudo, owner: g.ownerUID, nbMembres: Object.keys(g.membres).length, max: g.limiteUsers });
    });

    socket.on('envoi_message', (txt) => {
        const g = db.groupes[socket.nomGroupe];
        if (g) {
            const m = { texte: txt, auteur: socket.pseudo, date: Date.now() };
            g.messages.push(m);
            sauvegarder();
            io.to(socket.nomGroupe).emit('nouveau_message', m);
            diffuserSalons();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Serveur PayPal prêt sur port ${PORT}`));
