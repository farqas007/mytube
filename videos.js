// ================= SHARED VIDEO DATASET =================
// Single source of truth for ALL 20 videos.
// Used by both the homepage (index.html) and the watch page (watch.js).
//
// id            : stable, unique string id (used in watch.html?id=<id>)
// title/file    : display title + video file path
// thumb         : thumbnail path
// time          : display duration shown on the homepage card badge
// views/date    : demo metadata (display only — not real statistics)
// channel/subs  : demo channel metadata (display only)
// category      : used to rank related/up-next videos
// description   : long-form description (expand/collapse on watch page)
//
// IMPORTANT: array ORDER is significant. Legacy watch.html?id=<number>
// URLs map to this array by index (0-19) for backward compatibility.
// Every `file` and `thumb` must point to a real file (verified separately).

(function(){
    const videos = [
        {
            id: "ghajini",
            title: "Neon Night Drive",
            file: "videos/Ghajini.mp4",
            thumb: "thumbnails/Ghajini.jpg",
            time: "04:12",
            description: "A quiet late-night drive through glowing city streets, captured in soft neon light. A relaxing demo clip with no dialogue, made purely for testing playback.",
            channel: "NeoForge",
            subscribers: "1.2K subscribers",
            views: "48K views",
            // Numeric view count used for the local/demo Trending sort (not a real YouTube stat).
            viewCount: 48000,
            date: "Sep 3, 2026",
            category: "Gaming"
        },
        {
            id: "de-dana-dan",
            title: "Pixel Storm Arena",
            file: "videos/De dana dan.mp4",
            thumb: "thumbnails/De dana dan.jpg",
            time: "05:30",
            description: "A bright, fast-paced arcade match in a fictional pixel arena. All characters and scenes are original demo assets created for this site.",
            channel: "PixelNova",
            subscribers: "980 subscribers",
            views: "21K views",
            viewCount: 21000,
            date: "Aug 28, 2026",
            category: "Gaming"
        },
        {
            id: "train-to-bhutan",
            title: "Cyber City Lights",
            file: "videos/train_to_bhutan.mp4",
            thumb: "thumbnails/train_to_bhutan.jpg",
            time: "03:45",
            description: "A montage of fictional city skylines and animated light trails after dark. Original computer-generated footage made for this demo.",
            channel: "FutureLab",
            subscribers: "740 subscribers",
            views: "9.4K views",
            viewCount: 9400,
            date: "Aug 21, 2026",
            category: "Technology"
        },
        {
            id: "silent-hacker",
            title: "Midnight Gaming Lab",
            file: "videos/silent_hacker.mp4",
            thumb: "thumbnails/silent_hacker.jpg",
            time: "06:20",
            description: "A quick tour of a fictional setup where demo game tests run overnight. No real people, products, or brands appear in this clip.",
            channel: "CircuitCore",
            subscribers: "2.4K subscribers",
            views: "75K views",
            viewCount: 75000,
            date: "Aug 15, 2026",
            category: "Gaming"
        },
        {
            id: "shaapit",
            title: "Future Tech Room",
            file: "videos/shaapit.mp4",
            thumb: "thumbnails/shaapit.jpg",
            time: "02:50",
            description: "A short look inside a fictional concept room filled with imagined gadgets and soft ambient lighting. Entirely original demo content.",
            channel: "FutureLab",
            subscribers: "740 subscribers",
            views: "3.1K views",
            viewCount: 3100,
            date: "Aug 9, 2026",
            category: "Technology"
        },
        {
            id: "ra-one",
            title: "Space Signal",
            file: "videos/ra_one.mp4",
            thumb: "thumbnails/ra_one.jpg",
            time: "07:15",
            description: "An animated visualization of a make-believe radio signal traveling between fictional planets. Educational demo content with no real spacecraft.",
            channel: "AstroVisuals",
            subscribers: "1.6K subscribers",
            views: "63K views",
            viewCount: 63000,
            date: "Aug 2, 2026",
            category: "Science"
        },
        {
            id: "phoonk",
            title: "Digital Horizon",
            file: "videos/phoonk.mp4",
            thumb: "thumbnails/phoonk.jpg",
            time: "04:40",
            description: "A slow, abstract pan across a stylized digital landscape. Original graphics generated for this demo site.",
            channel: "CyberFrame",
            subscribers: "510 subscribers",
            views: "17K views",
            viewCount: 17000,
            date: "Jul 27, 2026",
            category: "Technology"
        },
        {
            id: "hungama",
            title: "Neon Racing Circuit",
            file: "videos/hungama.mp4",
            thumb: "thumbnails/hungama.jpg",
            time: "03:10",
            description: "A fictional hover-car race around a made-up neon circuit. All vehicles and tracks are original demo assets.",
            channel: "NeoForge",
            subscribers: "1.2K subscribers",
            views: "39K views",
            viewCount: 39000,
            date: "Jul 20, 2026",
            category: "Gaming"
        },
        {
            id: "hulchul",
            title: "AI Creator Studio",
            file: "videos/hulchul.mp4",
            thumb: "thumbnails/hulchul.jpg",
            time: "05:05",
            description: "A fictional walkthrough of a demo creation studio where imaginary AI tools help make clips. No real software or companies are shown.",
            channel: "PixelNova",
            subscribers: "980 subscribers",
            views: "11K views",
            viewCount: 11000,
            date: "Jul 14, 2026",
            category: "Creative"
        },
        {
            id: "horror-story",
            title: "Virtual World Explorer",
            file: "videos/horror_story.mp4",
            thumb: "thumbnails/horror_story.jpg",
            time: "08:00",
            description: "A calm exploration of an invented virtual world made from generic 3D shapes. Original demo footage created for this website.",
            channel: "GlitchGrid",
            subscribers: "890 subscribers",
            views: "22K views",
            viewCount: 22000,
            date: "Jul 8, 2026",
            category: "Technology"
        },
        {
            id: "entertainment",
            title: "Electric Skyline",
            file: "videos/entertainment.mp4",
            thumb: "thumbnails/entertainment.jpg",
            time: "02:35",
            description: "A short ambient film of a fictional skyline flickering with electric light. Purely generative demo imagery.",
            channel: "RetroByte",
            subscribers: "430 subscribers",
            views: "8.2K views",
            viewCount: 8200,
            date: "Jul 2, 2026",
            category: "Entertainment"
        },
        {
            id: "dhamaal",
            title: "Cyber Quest",
            file: "videos/dhamaal.mp4",
            thumb: "thumbnails/dhamaal.jpg",
            time: "09:20",
            description: "A make-believe adventure through a fictional cyber maze. The hero and world are original demo characters invented for this site.",
            channel: "CircuitCore",
            subscribers: "2.4K subscribers",
            views: "91K views",
            viewCount: 91000,
            date: "Jun 26, 2026",
            category: "Gaming"
        },
        {
            id: "delhi-safari",
            title: "Retro Pixel Zone",
            file: "videos/delhi_safari.mp4",
            thumb: "thumbnails/delhi_safari.jpg",
            time: "01:55",
            description: "A playful animated scene in a retro pixel art style. All artwork is original and generated for this demo.",
            channel: "RetroByte",
            subscribers: "430 subscribers",
            views: "5.6K views",
            viewCount: 5600,
            date: "Jun 20, 2026",
            category: "Animation"
        },
        {
            id: "bhool-bhulaiyaa",
            title: "Future Gadgets Lab",
            file: "videos/bhool_bhulaiyaa.mp4",
            thumb: "thumbnails/bhool_bhulaiyaa.jpg",
            time: "06:45",
            description: "A speculative look at invented gadgets that do not exist, presented in a clean demo style. No real brands or products are featured.",
            channel: "FutureLab",
            subscribers: "740 subscribers",
            views: "28K views",
            viewCount: 28000,
            date: "Jun 14, 2026",
            category: "Technology"
        },
        {
            id: "bhagam-bhag",
            title: "Cosmic Interface",
            file: "videos/bhagam_bhag.mp4",
            thumb: "thumbnails/bhagam_bhag.jpg",
            time: "04:15",
            description: "An animated user interface concept floating in a stylized cosmic background. Original demo artwork throughout.",
            channel: "AstroVisuals",
            subscribers: "1.6K subscribers",
            views: "44K views",
            viewCount: 44000,
            date: "Jun 8, 2026",
            category: "Science"
        },
        {
            id: "ajab-prem",
            title: "Night City Gameplay",
            file: "videos/ajab_prem.mp4",
            thumb: "thumbnails/ajab_prem.jpg",
            time: "07:30",
            description: "Gameplay footage from an imaginary night-city demo level built with generic assets. Never released and not an official game.",
            channel: "GlitchGrid",
            subscribers: "890 subscribers",
            views: "33K views",
            viewCount: 33000,
            date: "Jun 2, 2026",
            category: "Gaming"
        },
        {
            id: "agent-sai",
            title: "Digital Adventure",
            file: "videos/agent_sai.mp4",
            thumb: "thumbnails/agent_sai.jpg",
            time: "03:55",
            description: "A short narrated story about a fictional explorer in a made-up digital land. Entirely original content for demo purposes.",
            channel: "NeoForge",
            subscribers: "1.2K subscribers",
            views: "14K views",
            viewCount: 14000,
            date: "May 27, 2026",
            category: "Entertainment"
        },
        {
            id: "1920-london",
            title: "Neon Battle Arena",
            file: "videos/1920_london.mp4",
            thumb: "thumbnails/1920_london.jpg",
            time: "05:50",
            description: "A two-minute battle between generic robots in a fictional arena. Original 3D demo animation with no licensed characters.",
            channel: "CyberFrame",
            subscribers: "510 subscribers",
            views: "26K views",
            viewCount: 26000,
            date: "May 21, 2026",
            category: "Gaming"
        },
        {
            id: "8x10-tasveer",
            title: "Creator Workflow",
            file: "videos/8x10_tasveer.mp4",
            thumb: "thumbnails/8x10_tasveer.jpg",
            time: "02:20",
            description: "A fictional, generic look at how a demo creator might organize ideas, clips, and edits. No real person is shown.",
            channel: "PixelNova",
            subscribers: "980 subscribers",
            views: "7.8K views",
            viewCount: 7800,
            date: "May 15, 2026",
            category: "Creative"
        },
        {
            id: "3am-horror",
            title: "Tomorrow's Technology",
            file: "videos/3am.mp4",
            thumb: "thumbnails/3am.jpg",
            time: "04:05",
            description: "An optimistic concept piece about imagined future technology, built entirely from original demo graphics and sound.",
            channel: "AstroVisuals",
            subscribers: "1.6K subscribers",
            views: "52K views",
            viewCount: 52000,
            date: "May 9, 2026",
            category: "Science"
        }
    ];

    window.MyTubeVideos = videos;

    // Derived unique category list (single source of truth, never hardcoded separately).
    window.MyTubeCategories = [...new Set(videos.map(v => v.category))].sort();
})();
