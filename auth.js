// ================= FIREBASE AUTH =================

console.log("AUTH JS LOADED");


import { auth } from "./firebase.js";

import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged
}
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";




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

        msg.innerHTML="Email and Password required ❌";
        return;

    }



    try{


        await createUserWithEmailAndPassword(
            auth,
            email,
            password
        );


        msg.innerHTML="Account Created ✅";


        setTimeout(()=>{

            window.location.href="login.html";

        },1500);



    }


    catch(error){

        console.log(error.code);

        msg.innerHTML=error.message;

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

        msg.innerHTML="Email and Password required ❌";

        return;

    }





    try{


        await signInWithEmailAndPassword(
            auth,
            email,
            password
        );



        msg.innerHTML="Login Successful ✅";



        setTimeout(()=>{

            window.location.href="index.html";

        },1000);



    }


    catch(error){


        console.log(error.code);


        msg.innerHTML=error.message;


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

            loginBtn.innerHTML="Logged In ✅";

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

            loginBtn.innerHTML="Login";

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