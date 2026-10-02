// ================= FIREBASE AUTH =================

console.log("AUTH JS LOADED");


import { auth } from "./firebase.js";

import {
    createUserWithEmailAndPassword,
    onAuthStateChanged,
    sendPasswordResetEmail,
    signInWithEmailAndPassword,
    signOut
}
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";



// ================= SAFE ERROR MAPPING =================
// Firebase error messages can reveal whether an account exists or leak
// internal implementation detailsches. Map to safe, generic messages and
// never surface raw Firebase error.message/error.code in the UI.

const FRIENDLY_AUTH_ERRORS = {
    "auth/email-already-in-use": "An account with this email already exists.",
    "auth/invalid-email":        "Please enter a valid email address.",
    "auth/weak-password":        "Password does not meet the required security rules.",
    "auth/user-not-found":       "Invalid email or password.",
    "auth/wrong-password":       "Invalid email or password.",
    "auth/invalid-credential":   "Invalid email or password.",
    "auth/too-many-requests":    "Too many attempts. Please try again later.",
    "auth/network-request-failed": "Network error. Please check your connection and try again."
};


function friendlyAuthError(error){
    // Prefer a generic message for known codes; otherwise fall back to a safe
    // generic message. Never expose the raw Firebase error.message to users.
    const rawCode = error && error.code ? String(error.code) : "";
    return FRIENDLY_AUTH_ERRORS[rawCode] || "Something went wrong. Please try again.";
}




// ================= SIGN UP =================

window.signup = async function(){


    const email = document
    .getElementById("email")
    .value
    .trim();


    const password = document
    .getElementById("password")
    .value
    .trim();


    const msg = document.getElementById("msg");



    if(!email || !password){

        msg.textContent="Email and Password required ❌";
        return;

    }



    try{


        await createUserWithEmailAndPassword(
            auth,
            email,
            password
        );


        msg.textContent="Account Created ✅";


        setTimeout(()=>{

            window.location.href="index.html";

        },1500);



    }
    catch(error){


        console.log(error.code);


        msg.textContent=friendlyAuthError(error);


    }

};








// ================= LOGIN =================

window.loginUser = async function(){


    console.log("Login button clicked");


    const email =
    document.getElementById("email")
    .value
    .trim();



    const password =
    document.getElementById("password")
    .value
    .trim();



    const msg =
    document.getElementById("msg");



    if(!email || !password){

        msg.textContent="Email and Password required ❌";

        return;

    }





    try{


        await signInWithEmailAndPassword(
            auth,
            email,
            password
        );



        msg.textContent="Login Successful ✅";



        setTimeout(()=>{

            window.location.href="index.html";

        },1000);



    }


    catch(error){


        console.log(error.code);


        msg.textContent=friendlyAuthError(error);


    }


};









// ================= LOGOUT =================

window.logoutUser = async function(){


    try{


        await signOut(auth);


        window.location.href="login.html";


    }


    catch(error){


        console.log(error);


    }


};









// ================= FORGOT PASSWORD =================


window.resetPassword = async function(){


    const email = document
    .getElementById("resetEmail")
    .value
    .trim();


    const msg = document.getElementById("resetMsg");



    if(!email){

        msg.textContent="Email is required ❌";
        return;

    }



    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if(!validEmail.test(email)){

        msg.textContent="Please enter a valid email address ❌";
        return;

    }



    try{


        await sendPasswordResetEmail(auth, email);


        msg.textContent="If that account exists, a password reset email has been sent ✅";


        document.getElementById("resetEmail").value="";


    }


    catch(error){


        console.log(error.code);


        msg.textContent="Could not send the reset email. Please try again later ❌";


    }


};




// ================= COMMENT IDENTITY =================


function saveCommentIdentity(user){
    // Store a local, non-sensitive commenter identity used by the
    // watch page comments system (localStorage only).
    const name = user.displayName || (user.email ? user.email.split("@")[0] : "User") || "User";
    try{
        localStorage.setItem("mytube_comment_user", user.uid);
        localStorage.setItem("mytube_comment_name", name);
    }
    catch(error){
        console.log("Could not save comment identity:", error);
    }
}


function clearCommentIdentity(){
    try{
        localStorage.removeItem("mytube_comment_user");
        localStorage.removeItem("mytube_comment_name");
    }
    catch(error){
        console.log("Could not clear comment identity:", error);
    }
}




// ================= AUTH STATE =================


onAuthStateChanged(auth,(user)=>{


    const loginBtn =
    document.getElementById("loginBtn");


    const logoutBtn =
    document.getElementById("logoutBtn");


    // Only re-purpose the header navigation Login button,
    // never the login/signup page's submit button.
    const isHeaderLoginBtn =
        loginBtn ? loginBtn.closest("header") : null;




    if(user){


        saveCommentIdentity(user);


        if(isHeaderLoginBtn){

            loginBtn.textContent="Logged In ✅";

            loginBtn.onclick=function(){

                window.location.href="index.html";

            };

        }



        if(logoutBtn){

            logoutBtn.style.display="block";

            logoutBtn.onclick = window.logoutUser;

        }



    }


    else{


        clearCommentIdentity();


        if(isHeaderLoginBtn){

            loginBtn.textContent="Login";

            loginBtn.onclick=function(){

                window.location.href="login.html";

            };

        }



        if(logoutBtn){

            logoutBtn.style.display="none";

        }


    }


    // Let any page listening (e.g. the watch page comment form)
    // refresh its logged-in state.
    window.dispatchEvent(new Event("mytube-auth-change"));


});




// ================= WIRE FORMS =================


const loginForm =
document.getElementById("loginForm");

if(loginForm){

    loginForm.addEventListener("submit",(e)=>{

        e.preventDefault();

        loginUser();

    });

}


const signupForm =
document.getElementById("signupForm");

if(signupForm){

    signupForm.addEventListener("submit",(e)=>{

        e.preventDefault();

        signup();

    });

}




const resetForm =
document.getElementById("resetForm");

if(resetForm){

    resetForm.addEventListener("submit",(e)=>{

        e.preventDefault();

        resetPassword();

    });

}


const forgotLink =
document.getElementById("forgotLink");

if(forgotLink){

    forgotLink.addEventListener("click",(e)=>{

        e.preventDefault();

        const resetBox =
        document.getElementById("resetBox");

        if(!resetBox) return;

        resetBox.style.display="block";

        const resetEmail =
        document.getElementById("resetEmail");

        if(resetEmail){
            resetEmail.focus();
        }

        resetBox.scrollIntoView({
            behavior: "smooth",
            block: "nearest"
        });

    });

}


const cancelReset =
document.getElementById("cancelReset");

if(cancelReset){

    cancelReset.addEventListener("click",(e)=>{

        e.preventDefault();

        const resetBox =
        document.getElementById("resetBox");

        if(resetBox){
            resetBox.style.display="none";
        }

    });

}