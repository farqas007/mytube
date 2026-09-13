// ================= FIREBASE CONFIG =================


import { initializeApp } from 
"https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";


import { getAuth } from 
"https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";


import { getFirestore } from 
"https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";




// ================= FIREBASE REAL CONFIG =================


const firebaseConfig = {

    apiKey: "AIzaSyDPm6cYWFLUk99pB1D7EFt-BxvE0OSiL94",

    authDomain: "mytube-827d2.firebaseapp.com",

    projectId: "mytube-827d2",

    storageBucket: "mytube-827d2.firebasestorage.app",

    messagingSenderId: "23111129516",

    appId: "1:23111129516:web:438c7da2cff936e1468209"

};




// ================= INITIALIZE FIREBASE =================


const app = initializeApp(firebaseConfig);




// ================= EXPORT SERVICES =================


export const auth = getAuth(app);

export const db = getFirestore(app);


console.log("Firebase Connected ✅");