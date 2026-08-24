
const WORLD_CONFIG = {
  beta: {
    id: "beta",
    name: "Monde Bêta",
    label: "🧪 Monde Bêta",
    eyebrow: "MONDE BÊTA • FRANCE",
    storageKey: "autoRepState_beta",
    description: "Serveur de test : économie accélérée, fonctionnalités expérimentales et remise à zéro possible.",
    initialCash: 250000,
    initialReputation: 25,
    initialDay: 18,
    publicBudget: 9000000,
    city: "Dijon",
    region: "Bourgogne-Franche-Comté",
    marketMultiplier: 0.92
  },
  world1: {
    id: "world1",
    name: "Monde 1",
    label: "🌍 Monde 1",
    eyebrow: "MONDE 1 • FRANCE",
    storageKey: "autoRepState_world1",
    description: "Monde officiel : économie neuve, progression normale et historique persistant.",
    initialCash: 250000,
    initialReputation: 5,
    initialDay: 1,
    publicBudget: 2500000,
    city: "Dijon",
    region: "Bourgogne-Franche-Comté",
    marketMultiplier: 1
  }
};

let currentWorld = localStorage.getItem("autoRepCurrentWorld") || "beta";

function freshState(worldId){
  const cfg = WORLD_CONFIG[worldId];
  const baseMarket = [
    {id:101,name:"Peugeot 208",year:2017,km:112300,condition:79,price:6900},
    {id:102,name:"Volkswagen Golf VII",year:2015,km:164800,condition:63,price:7450},
    {id:103,name:"Citroën C3",year:2018,km:87900,condition:84,price:8100},
    {id:104,name:"BMW Série 1",year:2014,km:176100,condition:58,price:9900},
  ].map(v => ({...v, price: Math.round(v.price * cfg.marketMultiplier)}));

  return {
    worldId,
    day: cfg.initialDay,
    cash: cfg.initialCash,
    reputation: cfg.initialReputation,
    gold: 100,
    city: cfg.city,
    region: cfg.region,
    vehicles: worldId === "beta" ? [
      {id:1,name:"Renault Clio IV",year:2016,km:128400,condition:68,value:6200,buy:4700,status:"Garage"},
      {id:2,name:"Peugeot 308",year:2018,km:96400,condition:81,value:9600,buy:8200,status:"Garage"}
    ] : [
      {id:1,name:"Renault Clio IV",year:2016,km:128400,condition:68,value:6200,buy:4700,status:"Garage"}
    ],
    market: baseMarket,
    loans: [],
    articles: worldId === "beta" ? [
      {time:"Jour 18 • Bêta", title:"Test économique en cours", text:"Les prix, aides et règles peuvent être modifiés afin d'équilibrer le futur Monde 1."},
      {time:"Jour 17 • Bêta", title:"Les institutions ouvrent leurs portes", text:"Banques, justice, presse et politique sont disponibles pour les essais communautaires."}
    ] : [
      {time:"Jour 1", title:"Ouverture officielle du Monde 1", text:"Une nouvelle économie démarre. Chaque entreprise et chaque fortune reste à construire."},
      {time:"Jour 1", title:"Dijon cherche ses premiers entrepreneurs", text:"La municipalité souhaite attirer garages, concessions et sociétés de location."}
    ],
    cases: [],
    publicBudget: cfg.publicBudget,
    lastDailyUpdate: new Date().toLocaleDateString("en-CA"),
  };
}

function loadWorld(worldId){
  const cfg = WORLD_CONFIG[worldId];
  const stored = localStorage.getItem(cfg.storageKey);
  return stored ? JSON.parse(stored) : freshState(worldId);
}

let state = loadWorld(currentWorld);

function save(){
  localStorage.setItem(WORLD_CONFIG[currentWorld].storageKey, JSON.stringify(state));
  localStorage.setItem("autoRepCurrentWorld", currentWorld);
  updateTop();
}
function money(n){ return new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(n); }
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2200)}
function updateTop(){document.getElementById('cashTop').textContent=money(state.cash);document.getElementById('repTop').textContent=state.reputation;const g=document.getElementById('goldTop');if(g)g.textContent=state.gold??0}
function card(title,value,sub,cls=""){return `<div class="card"><div class="muted">${title}</div><div class="metric ${cls}">${value}</div><div class="muted">${sub}</div></div>`}

const pages = {
dashboard(){
  const fleetVal=state.vehicles.reduce((s,v)=>s+v.value,0);
  const cfg=WORLD_CONFIG[currentWorld];
  return `
  <div class="world-banner ${currentWorld}">
    <div><span class="world-badge">${cfg.label}</span><div class="muted">${cfg.description}</div></div>
    <strong>Jour ${state.day}</strong>
  </div>
  <div class="hero">
    <div>
      <p class="eyebrow">JOUR ${state.day}</p>
      <h3>${currentWorld === 'beta' ? 'Bienvenue sur le terrain d’essai.' : 'Bienvenue dans ton empire automobile.'}</h3>
      <p class="muted">${currentWorld === 'beta' ? 'Teste les mécaniques, l’économie et les institutions avant leur arrivée officielle.' : `Achète, répare, loue, vends et construis ton influence économique dans ${state.city}.`}</p>
      <div class="statline">
        <div><strong>${state.vehicles.length}</strong><span class="muted">véhicule(s)</span></div>
        <div><strong>${money(fleetVal)}</strong><span class="muted">valeur de flotte</span></div>
        <div><strong>${state.cases.length}</strong><span class="muted">dossier(s) de justice</span></div>
      </div>
    </div>
  </div>
  ${currentWorld === "beta" ? `<div style="margin-top:12px"><button class="danger" onclick="resetBeta()">Réinitialiser la bêta</button></div>` : ""}
  <div class="grid cols-4" style="margin-top:16px">
    ${card("Trésorerie",money(state.cash),"Disponible immédiatement","good")}
    ${card("Patrimoine",money(state.cash+fleetVal),"Liquidités + véhicules")}
    ${card("Réputation",state.reputation+"/100","Influence auprès des joueurs","blue")}
    ${card("Territoire",state.city,state.region)}
  </div>
  <div class="grid cols-2" style="margin-top:16px">
    <div class="card"><h3>Activité récente</h3>${state.articles.slice(0,4).map(n=>`<div class="news"><div class="time">${n.time}</div><strong>${n.title}</strong><div class="muted">${n.text}</div></div>`).join("")}</div>
    <div class="card"><h3>Objectifs de départ</h3>
      <div class="news">🚗 Posséder 3 véhicules</div>
      <div class="news">🔧 Réparer un véhicule sous 75 % d'état</div>
      <div class="news">💰 Réaliser une première vente rentable</div>
      <div class="news">🏢 Atteindre 50 000 € de patrimoine</div>
    </div>
  </div>`;
},
market(){
  return `<div class="card"><div class="section-title"><h3>Marché des véhicules d'occasion</h3><span class="tag">${state.market.length} annonces</span></div>
  <table><thead><tr><th>Véhicule</th><th>Année</th><th>Km</th><th>État</th><th>Prix</th><th></th></tr></thead>
  <tbody>${state.market.map(v=>`<tr><td><strong>${v.name}</strong><br><span class="muted">Annonce #${v.id}</span></td><td>${v.year}</td><td>${v.km.toLocaleString('fr-FR')}</td><td>${v.condition}%</td><td>${money(v.price)}</td><td><button class="primary" onclick="buy(${v.id})">Acheter</button></td></tr>`).join("")}</tbody></table></div>`;
},
garage(){
  return `<div class="grid cols-2">
    <div class="card"><h3>Mes véhicules</h3>${state.vehicles.length?state.vehicles.map(v=>`<div class="vehicle"><div><strong>${v.name}</strong><span class="muted">${v.year} • ${v.km.toLocaleString('fr-FR')} km • ${v.status}</span><div class="progress"><span style="width:${v.condition}%"></span></div><small class="muted">État ${v.condition}% • Valeur ${money(v.value)}</small></div><div><button class="secondary" onclick="repair(${v.id})">Réparer</button> <button class="primary" onclick="sell(${v.id})">Vendre</button></div></div>`).join(""):`<p class="muted">Aucun véhicule.</p>`}</div>
    <div class="card"><h3>Atelier</h3><p class="muted">Les réparations coûtent 90 € par point d'état manquant jusqu'à 100 %. Elles augmentent la valeur du véhicule.</p><p>À terme : mécaniciens joueurs, pièces détachées, devis, contrats d'entretien et appels d'offres.</p></div>
  </div>`;
},
territory(){
 return `<div class="grid cols-3">
 ${card("Pays","France","Présidence nationale")}
 ${card("Région",state.region,"Conseil régional")}
 ${card("Ville",state.city,"Municipalité")}
 </div>
 <div class="card" style="margin-top:16px"><h3>Économie locale</h3>
 <table><tr><th>Indicateur</th><th>${state.city}</th><th>${state.region}</th></tr>
 <tr><td>Entreprises automobiles</td><td>14</td><td>128</td></tr>
 <tr><td>Demande automobile</td><td class="good">Forte</td><td>Moyenne</td></tr>
 <tr><td>Fiscalité entreprise</td><td>4,0 %</td><td>2,0 %</td></tr>
 <tr><td>Budget public</td><td>${money(state.publicBudget)}</td><td>${money(18700000)}</td></tr></table></div>`;
},
materials(){return `<div class="card"><h3>Matières premières</h3><p class="muted">Chargement serveur…</p></div>`;},
payroll(){return `<div class="card"><h3>Salaires</h3><p class="muted">Chargement serveur…</p></div>`;},
taxes(){return `<div class="card"><h3>Fiscalité</h3><p class="muted">Chargement serveur…</p></div>`;},
tenders(){return `<div class="card"><h3>Marchés publics</h3><p class="muted">Chargement serveur…</p></div>`;},
economy(){return `<div class="card"><h3>Économie territoriale</h3><p class="muted">Chargement serveur…</p></div>`;},
bankruptcy(){return `<div class="card"><h3>Faillites</h3><p class="muted">Chargement serveur…</p></div>`;},
industry(){return `<div class="card"><h3>Industrie</h3><p class="muted">Chargement serveur…</p></div>`;},
insurance(){return `<div class="card"><h3>Assurances</h3><p class="muted">Chargement serveur…</p></div>`;},
logistics(){return `<div class="card"><h3>Logistique</h3><p class="muted">Chargement serveur…</p></div>`;},
exchange(){return `<div class="card"><h3>Bourse</h3><p class="muted">Chargement serveur…</p></div>`;},
companies(){ return `<div class="card"><h3>Entreprises</h3><p class="muted">Chargement depuis le serveur…</p></div>`; },
contracts(){ return `<div class="card"><h3>Contrats</h3><p class="muted">Chargement depuis le serveur…</p></div>`; },
auctions(){ return `<div class="card"><h3>Enchères judiciaires</h3><p class="muted">Chargement depuis le serveur…</p></div>`; },
enforcement(){ return `<div class="card"><h3>Huissier</h3><p class="muted">Chargement depuis le serveur…</p></div>`; },
bank(){
 return `<div class="grid cols-3">${card("Solde",money(state.cash),"Compte professionnel","good")}${card("Crédits actifs",state.loans.length,"Banques partenaires")}${card("Taux indicatif","4,8 %","Crédit professionnel")}</div>
 <div class="grid cols-2" style="margin-top:16px">
 <div class="card"><h3>Demander un crédit</h3><label>Montant</label><input id="loanAmount" type="number" value="10000"><label style="margin-top:10px">Banque</label><select id="loanBank"><option>Banque Nationale</option><option>Banque Régionale BFC</option><option>Curly Finance</option></select><button class="primary" style="margin-top:12px" onclick="loan()">Envoyer la demande</button></div>
 <div class="card"><h3>Vision bancaire</h3><p class="muted">Cette version simule une réponse automatique. La version multijoueur permettra à une banque privée tenue par un joueur d'accepter, refuser ou contre-proposer.</p>${state.loans.map(l=>`<div class="news"><strong>${l.bank}</strong><div class="muted">${money(l.amount)} • 4,8 %</div></div>`).join("")}</div>
 </div>`;
},

shop(){
 return `<div class="hero gold-hero"><div><p class="eyebrow">BOUTIQUE PREMIUM</p><h3>Gold Auto République</h3>
 <p class="muted">Le Gold accélère nettement le développement économique et débloque des services premium. Les élections, jugements et pouvoirs publics restent hors boutique.</p>
 <div class="statline"><div><strong>${state.gold??0}</strong><span class="muted">Gold disponible</span></div></div></div></div>
 <div class="grid cols-3" style="margin-top:16px">
 <div class="card"><h3>🪙 500 Gold</h3><div class="metric">4,99 €</div><p class="muted">Découverte</p><button class="primary" onclick="demoGold(500)">Tester le pack</button></div>
 <div class="card featured"><h3>🪙 1 500 Gold</h3><div class="metric">12,99 €</div><p class="muted">Entrepreneur</p><button class="primary" onclick="demoGold(1500)">Tester le pack</button></div>
 <div class="card"><h3>🪙 4 000 Gold</h3><div class="metric">29,99 €</div><p class="muted">Empire</p><button class="primary" onclick="demoGold(4000)">Tester le pack</button></div></div>
 <div class="section-title"><h3>Accélérateurs</h3></div><div class="grid cols-3">
 <div class="card"><h3>⚡ Atelier express</h3><p>Répare immédiatement le premier véhicule endommagé.</p><strong>75 Gold</strong><br><button class="secondary" style="margin-top:10px" onclick="buyBoost('repair',75)">Utiliser</button></div>
 <div class="card"><h3>📊 Pack Business</h3><p>Accélère la réputation économique.</p><strong>120 Gold</strong><br><button class="secondary" style="margin-top:10px" onclick="buyBoost('business',120)">Utiliser</button></div>
 <div class="card"><h3>🏢 Expansion</h3><p>Bonus de développement pour préparer de nouvelles entreprises.</p><strong>250 Gold</strong><br><button class="secondary" style="margin-top:10px" onclick="buyBoost('expansion',250)">Utiliser</button></div></div>
 <div class="card" style="margin-top:16px"><h3>Version test</h3><p class="muted">Aucun paiement réel n'est effectué dans ce prototype. Les packs créditent du Gold fictif pour tester l'équilibrage.</p></div>`;
},
politics(){
 return `<div class="grid cols-3">
 <div class="card"><h3>🏙️ Mairie de ${state.city}</h3><p>Maire : <strong>Vacant</strong></p><p class="muted">Prochaine élection : dans 5 jours</p><button class="primary" onclick="candidate('municipales')">Être candidat</button></div>
 <div class="card"><h3>🗺️ Région</h3><p>Présidence : <strong>Vacante</strong></p><p class="muted">Aides économiques et infrastructures.</p><button class="secondary" onclick="toast('Débloqué après une première élection municipale')">Voir les compétences</button></div>
 <div class="card"><h3>🇫🇷 Présidence</h3><p>Présidence : <strong>Vacante</strong></p><p class="muted">Lois nationales et politiques économiques.</p><button class="secondary" onclick="toast('Fonction nationale prévue dans la prochaine étape')">Voir les lois</button></div>
 </div>
 <div class="card" style="margin-top:16px"><h3>Aide municipale proposée</h3><p class="muted">Les élus pourront créer des aides financées par le véritable budget public.</p><div class="form-row"><div><label>Type d'aide</label><select><option>Prime véhicule électrique</option><option>Aide installation garage</option></select></div><div><label>Budget</label><input value="500000"></div></div></div>`;
},
press(){
 return `<div class="grid cols-2">
 <div class="card"><h3>Fil agence</h3>${state.articles.map(n=>`<div class="news"><div class="time">${n.time}</div><strong>${n.title}</strong><div class="muted">${n.text}</div></div>`).join("")}</div>
 <div class="card"><h3>Salle de rédaction</h3><label>Titre</label><input id="artTitle" placeholder="Titre de l'article"><label style="margin-top:10px">Article</label><textarea id="artText" rows="7" placeholder="Rédigez votre information..."></textarea><button class="primary" style="margin-top:12px" onclick="publish()">Publier</button><p class="muted">Dans la version communautaire : propriétaire du média, rédacteur en chef, journalistes, abonnés, publicité et accès aux données publiques.</p></div>
 </div>`;
},
justice(){
 return `<div class="grid cols-2">
 <div class="card"><h3>Saisir le tribunal</h3><label>Défendeur</label><input id="defendant" placeholder="Nom du joueur ou de l'entreprise"><label style="margin-top:10px">Motif</label><select id="caseType"><option>Facture impayée</option><option>Rupture de contrat</option><option>Véhicule non conforme</option><option>Litige bancaire</option><option>Marché public</option></select><label style="margin-top:10px">Montant réclamé</label><input id="claim" type="number" value="5000"><button class="primary" style="margin-top:12px" onclick="fileCase()">Déposer la requête</button></div>
 <div class="card"><h3>Dossiers</h3>${state.cases.length?state.cases.map(c=>`<div class="news"><strong>#${c.id} • ${c.type}</strong><div class="muted">Contre ${c.defendant} • ${money(c.claim)} • ${c.status}</div><button class="secondary" style="margin-top:8px" onclick="executeCase(${c.id})">Simuler jugement favorable</button></div>`).join(""):`<p class="muted">Aucune procédure en cours.</p>`}</div>
 </div>
 <div class="card" style="margin-top:16px"><h3>⚖️ Exécution par huissier</h3><p class="muted">Un jugement définitif génère un titre exécutoire. L'huissier peut ensuite faire bloquer et transférer les fonds autorisés, sans jamais pouvoir modifier librement le montant.</p></div>`;
}
};

function render(page="dashboard"){
 document.getElementById("app").innerHTML=pages[page]();
 document.getElementById("page-title").textContent=document.querySelector(`[data-page="${page}"]`).textContent.replace(/^[^\s]+\s/,'');
 updateTop();
}
document.querySelectorAll(".nav-btn").forEach(btn=>btn.onclick=()=>{
 document.querySelectorAll(".nav-btn").forEach(b=>b.classList.remove("active"));
 btn.classList.add("active"); render(btn.dataset.page);
});
document.getElementById("nextDay").onclick=()=>{
  applyDailyUpdate(true);
  render("dashboard");
};
function buy(id){
 const v=state.market.find(x=>x.id===id); if(!v)return;
 if(state.cash<v.price)return toast("Trésorerie insuffisante.");
 state.cash-=v.price;
 state.vehicles.push({...v,id:Date.now(),buy:v.price,value:Math.round(v.price*1.04),status:"Garage"});
 state.market=state.market.filter(x=>x.id!==id);state.reputation++;save();render("market");toast(`${v.name} acheté.`);
}
function repair(id){
 const v=state.vehicles.find(x=>x.id===id);const missing=100-v.condition;const cost=missing*90;
 if(missing===0)return toast("Ce véhicule est déjà en parfait état.");
 if(state.cash<cost)return toast(`Il faut ${money(cost)} pour la réparation.`);
 state.cash-=cost;v.condition=100;v.value=Math.round(v.value+cost*0.65);save();render("garage");toast("Réparation terminée.");
}
function sell(id){
 const v=state.vehicles.find(x=>x.id===id);const sale=Math.round(v.value*(0.95+Math.random()*0.12));
 state.cash+=sale;state.vehicles=state.vehicles.filter(x=>x.id!==id);state.reputation+=2;
 state.articles.unshift({time:`Jour ${state.day}`,title:"Transaction automobile",text:`${v.name} vendu pour ${money(sale)}.`});
 save();render("garage");toast(`Vente conclue : ${money(sale)}`);
}
function loan(){
 const amount=Number(document.getElementById("loanAmount").value);const bank=document.getElementById("loanBank").value;
 if(!amount||amount<1000)return toast("Montant invalide.");
 const accepted=amount<=30000;
 if(!accepted)return toast("Demande refusée : montant trop élevé pour votre profil actuel.");
 state.cash+=amount;state.loans.push({amount,bank});save();render("bank");toast("Crédit accepté et versé.");
}

function demoGold(amount){state.gold=(state.gold??0)+amount;save();render("shop");toast(`Test : +${amount} Gold`);}
function buyBoost(type,cost){
 state.gold=state.gold??0;if(state.gold<cost)return toast("Gold insuffisant.");
 state.gold-=cost;
 if(type==="repair"){const v=state.vehicles.find(v=>v.condition<100);if(v){v.condition=100;v.value=Math.round(v.value*1.08);}}
 if(type==="business")state.reputation+=5;
 if(type==="expansion")state.reputation+=10;
 save();render("shop");toast(`${cost} Gold utilisés.`);
}

function candidate(type){state.reputation+=1;save();toast(`Candidature aux ${type} enregistrée.`)}
function publish(){
 const title=document.getElementById("artTitle").value.trim(),text=document.getElementById("artText").value.trim();
 if(!title||!text)return toast("Titre et contenu requis.");
 state.articles.unshift({time:`Jour ${state.day} • Publication joueur`,title,text});state.reputation++;save();render("press");toast("Article publié.");
}
function fileCase(){
 const defendant=document.getElementById("defendant").value.trim(),type=document.getElementById("caseType").value,claim=Number(document.getElementById("claim").value);
 if(!defendant||claim<=0)return toast("Dossier incomplet.");
 state.cases.unshift({id:Math.floor(1000+Math.random()*9000),defendant,type,claim,status:"Audience à programmer"});save();render("justice");toast("Requête déposée au tribunal.");
}
function executeCase(id){
 const c=state.cases.find(x=>x.id===id);if(!c)return;
 c.status="Jugement favorable • titre exécutoire";
 const recovered=Math.round(c.claim*0.6);state.cash+=recovered;
 state.articles.unshift({time:`Jour ${state.day}`,title:"Justice",text:`Une saisie judiciaire de ${money(recovered)} a été exécutée dans le dossier #${c.id}.`});
 save();render("justice");toast(`Huissier : ${money(recovered)} recouvrés.`);
}

function resetBeta(){
  if(currentWorld !== "beta") return;
  state = freshState("beta");
  save();
  render("dashboard");
  toast("Monde Bêta réinitialisé.");
}

function updateWorldUI(){
  const select = document.getElementById("worldSelect");
  if(select) select.value = currentWorld;
  const eyebrow = document.getElementById("worldEyebrow");
  if(eyebrow) eyebrow.textContent = WORLD_CONFIG[currentWorld].eyebrow;
}

function switchWorld(worldId){
  if(!WORLD_CONFIG[worldId]) return;
  currentWorld = worldId;
  state = loadWorld(worldId);
  localStorage.setItem("autoRepCurrentWorld", currentWorld);
  applyMissedUpdates();
  updateWorldUI();
  render("dashboard");
  document.querySelectorAll(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.page==="dashboard"));
  toast(`${WORLD_CONFIG[worldId].name} chargé.`);
}

const worldSelect = document.getElementById("worldSelect");
if(worldSelect){
  worldSelect.value = currentWorld;
  worldSelect.addEventListener("change", e => switchWorld(e.target.value));
}


// Mise à jour automatique quotidienne
function dateKey(d=new Date()){
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), day=String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function dateDiffDays(a,b){
  const [ay,am,ad]=a.split("-").map(Number), [by,bm,bd]=b.split("-").map(Number);
  return Math.max(0, Math.floor((Date.UTC(by,bm-1,bd)-Date.UTC(ay,am-1,ad))/86400000));
}
function applyDailyUpdate(manual=false){
  state.day++;
  state.vehicles.forEach(v=>{
    if(v.status==="Location"){
      state.cash += 35;
      v.km += 120;
      v.condition = Math.max(20, v.condition-1);
      v.value = Math.max(500, Math.round(v.value*0.999));
    }
  });
  state.loans.forEach(l=>{
    if(l.balance == null) l.balance=l.amount;
    l.balance=Math.round(l.balance*(1+0.048/365)*100)/100;
  });
  state.market.forEach(v=>{
    v.price=Math.max(500,Math.round(v.price*(0.985+Math.random()*0.03)));
  });
  if(state.day%3===0){
    state.articles.unshift({time:`Jour ${state.day}`,title:"Marché automobile",text:"Les prix de l'occasion ont été actualisés."});
  }
  if(!manual){
    state.articles.unshift({time:`Jour ${state.day} • 00:00`,title:"Mise à jour quotidienne",text:"Revenus, usure, crédits et marché ont été actualisés automatiquement."});
  }
  state.lastDailyUpdate=dateKey();
  save();
}
function applyMissedUpdates(){
  const today=dateKey();
  if(!state.lastDailyUpdate){state.lastDailyUpdate=today;save();return}
  const n=dateDiffDays(state.lastDailyUpdate,today);
  for(let i=0;i<n;i++) applyDailyUpdate(false);
  state.lastDailyUpdate=today;
  save();
  if(n>0) toast(`${n} mise${n>1?"s":""} à jour de minuit appliquée${n>1?"s":""}.`);
}
function msToMidnight(){
  const n=new Date(), next=new Date(n);
  next.setHours(24,0,0,0);
  return next-n;
}
function scheduleMidnight(){
  setTimeout(()=>{
    applyMissedUpdates();
    render("dashboard");
    scheduleMidnight();
  }, msToMidnight()+1500);
}

applyMissedUpdates();
scheduleMidnight();
updateWorldUI();updateTop();render();


// Navigation mobile
const mobileButtons = document.querySelectorAll(".mobile-nav button");
mobileButtons.forEach(btn => btn.onclick = () => {
  const page = btn.dataset.page;
  if(page === "more"){
    const choices = ["territory","politics","press","justice"];
    const labels = {"territory":"Territoires","politics":"Politique","press":"Presse","justice":"Justice"};
    const picked = prompt("Ouvrir : " + choices.map((x,i)=>`${i+1}. ${labels[x]}`).join(" • "));
    const idx = Number(picked)-1;
    if(idx >= 0 && idx < choices.length){
      render(choices[idx]);
      document.getElementById("page-title").textContent = labels[choices[idx]];
    }
    return;
  }
  mobileButtons.forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  document.querySelectorAll(".nav-btn").forEach(b=>b.classList.toggle("active", b.dataset.page===page));
  render(page);
});
if(mobileButtons[0]) mobileButtons[0].classList.add("active");
