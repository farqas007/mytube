/* Voice Search — progressive enhancement for MyTube.
   Uses the Web Speech API where available; gracefully degrades otherwise. */
(function () {
    "use strict";

    var API = window.SpeechRecognition || window.webkitSpeechRecognition;
    var activeRecognition = null;
    var activeButton = null;
    var suppressSearch = false;

    function stopCurrentRecognition() {
        if (!activeRecognition) return;
        suppressSearch = true;
        try { activeRecognition.stop(); } catch (_e) { /* already stopped */ }
        activeRecognition = null;
        if (activeButton) {
            activeButton.classList.remove("listening");
            activeButton.setAttribute("aria-pressed", "false");
            activeButton = null;
        }
    }

    function showMessage(text) {
        var el = document.getElementById("sidebarMsg");
        if (!el) {
            el = document.createElement("div");
            el.id = "sidebarMsg";
            el.textContent = "";
            el.style.position = "fixed";
            el.style.bottom = "20px";
            el.style.left = "50%";
            el.style.transform = "translateX(-50%)";
            el.style.background = "#333";
            el.style.color = "white";
            el.style.padding = "12px 20px";
            el.style.borderRadius = "25px";
            el.style.zIndex = "2000";
            el.style.fontSize = "14px";
            document.body.appendChild(el);
        }
        el.textContent = text;
        setTimeout(function () { el.textContent = ""; }, 3500);
    }

    function startRecognition(button) {
        if (activeRecognition) {
            stopCurrentRecognition();
            return;
        }

        suppressSearch = false;

        var searchInput = document.getElementById("search");
        if (!searchInput) return;

        var recognition = new API();
        recognition.lang = navigator.language || "en-US";
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.continuous = false;

        activeRecognition = recognition;
        activeButton = button;
        button.classList.add("listening");
        button.setAttribute("aria-pressed", "true");

        var finalTranscript = "";

        recognition.onresult = function (event) {
            var interim = "";
            for (var i = event.resultIndex; i < event.results.length; i++) {
                var transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalTranscript += transcript;
                } else {
                    interim += transcript;
                }
            }
            searchInput.value = finalTranscript || interim;
        };

        recognition.onend = function () {
            activeRecognition = null;
            button.classList.remove("listening");
            button.setAttribute("aria-pressed", "false");
            activeButton = null;

            var query = finalTranscript.trim();
            if (query && !suppressSearch) {
                searchInput.value = query;
                if (typeof window.searchVideo === "function") {
                    window.searchVideo();
                }
            }
            suppressSearch = false;
        };

        recognition.onerror = function (event) {
            suppressSearch = true;
            activeRecognition = null;
            button.classList.remove("listening");
            button.setAttribute("aria-pressed", "false");
            activeButton = null;

            if (event.error === "not-allowed") {
                showMessage("Microphone access denied. Please allow microphone permission in your browser settings.");
            } else if (event.error === "no-speech") {
                showMessage("No speech detected. Please try again.");
            } else if (event.error !== "aborted") {
                showMessage("Voice search is unavailable. Please try again.");
            }
        };

        try {
            recognition.start();
        } catch (_e) {
            activeRecognition = null;
            button.classList.remove("listening");
            button.setAttribute("aria-pressed", "false");
            activeButton = null;
            showMessage("Could not start voice search. Please try again.");
        }
    }

    function init() {
        var buttons = document.querySelectorAll(".voice-search-btn");
        if (!buttons.length) return;

        if (!API) {
            buttons.forEach(function (btn) { btn.style.display = "none"; });
            return;
        }

        buttons.forEach(function (button) {
            button.addEventListener("click", function (e) {
                e.preventDefault();
                startRecognition(button);
            });
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
