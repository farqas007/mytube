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
            title: "Ghajini",
            file: "videos/Ghajini.mp4",
            thumb: "thumbnails/Ghajini.jpg",
            time: "10:00",
            description: "A man with short-term memory loss sets out to avenge the murder of his girlfriend, using tattoos and photographs as reminders of his mission. A gripping tale of love, loss and revenge.",
            channel: "Bollywood Clips",
            subscribers: "2.1M subscribers",
            views: "100K views",
            // Numeric view count used for the local/demo Trending sort (not a real YouTube stat).
            viewCount: 100000,
            date: "Sep 3, 2026",
            category: "Action"
        },
        {
            id: "de-dana-dan",
            title: "De Dana Dan",
            file: "videos/De dana dan.mp4",
            thumb: "thumbnails/De dana dan.jpg",
            time: "12:00",
            description: "A hilarious chain of events follows when a hotel accountant and his friend try to raise money to pay off a debt, only for their plan to spin wildly out of control.",
            channel: "Comedy Junction",
            subscribers: "980K subscribers",
            views: "200K views",
            viewCount: 200000,
            date: "Aug 28, 2026",
            category: "Comedy"
        },
        {
            id: "train-to-bhutan",
            title: "Train To Bhutan",
            file: "videos/train_to_bhutan.mp4",
            thumb: "thumbnails/train_to_bhutan.jpg",
            time: "24:18",
            description: "An emotional journey unfolds aboard a train headed to Bhutan, as passengers carry their hopes, dreams and secrets across the Himalayan landscape.",
            channel: "Travel Diaries",
            subscribers: "450K subscribers",
            views: "1.2M views",
            viewCount: 1200000,
            date: "Aug 21, 2026",
            category: "Drama"
        },
        {
            id: "silent-hacker",
            title: "Silent Hacker",
            file: "videos/silent_hacker.mp4",
            thumb: "thumbnails/silent_hacker.jpg",
            time: "18:42",
            description: "A brilliant but anonymous hacker races against time to expose a corporate conspiracy, navigating the digital underworld one encrypted message at a time.",
            channel: "Tech Thrillers",
            subscribers: "1.4M subscribers",
            views: "500K views",
            viewCount: 500000,
            date: "Aug 15, 2026",
            category: "Thriller"
        },
        {
            id: "shaapit",
            title: "Shaapit",
            file: "videos/shaapit.mp4",
            thumb: "thumbnails/shaapit.jpg",
            time: "2:01:44",
            description: "A couple find themselves bound by an ancient curse that dooms their union, forcing them to break the spell before it consumes their lives.",
            channel: "Horror Reels",
            subscribers: "3.2M subscribers",
            views: "3M views",
            viewCount: 3000000,
            date: "Aug 9, 2026",
            category: "Horror"
        },
        {
            id: "ra-one",
            title: "Ra One",
            file: "videos/ra_one.mp4",
            thumb: "thumbnails/ra_one.jpg",
            time: "2:34:15",
            description: "A video game villain escapes into the real world, and only the hero of the game can stop him in this larger-than-life sci-fi spectacle.",
            channel: "SuperBhai Movies",
            subscribers: "5.6M subscribers",
            views: "5M views",
            viewCount: 5000000,
            date: "Aug 2, 2026",
            category: "Sci-Fi"
        },
        {
            id: "phoonk",
            title: "PHOONK Horror Movie",
            file: "videos/phoonk.mp4",
            thumb: "thumbnails/phoonk.jpg",
            time: "1:55:20",
            description: "A supernatural force targets a modern-day family, and a desperate father enlists a hypnotist to save his daughter from a dark possession.",
            channel: "Horror Reels",
            subscribers: "3.2M subscribers",
            views: "4M views",
            viewCount: 4000000,
            date: "Jul 27, 2026",
            category: "Horror"
        },
        {
            id: "hungama",
            title: "Hungama",
            file: "videos/hungama.mp4",
            thumb: "thumbnails/hungama.jpg",
            time: "2:16:32",
            description: "A comedy of errors unfolds when a group of people get tangled in a web of mistaken identities, lies and chaos in this laugh-out-loud riot.",
            channel: "Comedy Junction",
            subscribers: "980K subscribers",
            views: "2M views",
            viewCount: 2000000,
            date: "Jul 20, 2026",
            category: "Comedy"
        },
        {
            id: "hulchul",
            title: "Hulchul",
            file: "videos/hulchul.mp4",
            thumb: "thumbnails/hulchul.jpg",
            time: "2:26:26",
            description: "Two feuding families, warring brothers and a love story born from chaos deliver a rollicking comedy packed with misunderstandings and mischief.",
            channel: "Comedy Junction",
            subscribers: "980K subscribers",
            views: "3M views",
            viewCount: 3000000,
            date: "Jul 14, 2026",
            category: "Comedy"
        },
        {
            id: "horror-story",
            title: "Horror Story",
            file: "videos/horror_story.mp4",
            thumb: "thumbnails/horror_story.jpg",
            time: "1:49:36",
            description: "Seven friends gather in a haunted hotel for a night of paranormal experiments, but each one slowly starts becoming a victim of the horror they unleashed.",
            channel: "Horror Reels",
            subscribers: "3.2M subscribers",
            views: "4M views",
            viewCount: 4000000,
            date: "Jul 8, 2026",
            category: "Horror"
        },
        {
            id: "entertainment",
            title: "Entertainment",
            file: "videos/entertainment.mp4",
            thumb: "thumbnails/entertainment.jpg",
            time: "2:20:45",
            description: "A down-and-out man inherits a fortune from his millionaire father along with his robot double, leading to a comedy of confusion and court battles.",
            channel: "Bollywood Clips",
            subscribers: "2.1M subscribers",
            views: "3M views",
            viewCount: 3000000,
            date: "Jul 2, 2026",
            category: "Comedy"
        },
        {
            id: "dhamaal",
            title: "Dhamaal",
            file: "videos/dhamaal.mp4",
            thumb: "thumbnails/dhamaal.jpg",
            time: "2:17:12",
            description: "Four friends stumble upon a hidden treasure and race across the city against a greedy villain in this fast-paced comedy adventure.",
            channel: "Comedy Junction",
            subscribers: "980K subscribers",
            views: "5M views",
            viewCount: 5000000,
            date: "Jun 26, 2026",
            category: "Comedy"
        },
        {
            id: "delhi-safari",
            title: "Delhi Safari",
            file: "videos/delhi_safari.mp4",
            thumb: "thumbnails/delhi_safari.jpg",
            time: "1:36:00",
            description: "A group of animals journeys to Delhi to protest the destruction of their forest, learning about friendship and courage along the way in this animated adventure.",
            channel: "Kids & Toons",
            subscribers: "720K subscribers",
            views: "1M views",
            viewCount: 1000000,
            date: "Jun 20, 2026",
            category: "Animation"
        },
        {
            id: "bhool-bhulaiyaa",
            title: "Bhool Bhulaiyaa",
            file: "videos/bhool_bhulaiyaa.mp4",
            thumb: "thumbnails/bhool_bhulaiyaa.jpg",
            time: "2:32:00",
            description: "A psychiatric doctor is called to an old mansion where a mysterious spirit seems to haunt its halls, blending comedy with genuine chills.",
            channel: "Horror Reels",
            subscribers: "3.2M subscribers",
            views: "8M views",
            viewCount: 8000000,
            date: "Jun 14, 2026",
            category: "Horror"
        },
        {
            id: "bhagam-bhag",
            title: "Bhagam Bhag",
            file: "videos/bhagam_bhag.mp4",
            thumb: "thumbnails/bhagam_bhag.jpg",
            time: "2:30:00",
            description: "A theatre troupe in London gets caught up in a murder mystery involving a missing actress, leading to a frantic hunt for the truth.",
            channel: "Bollywood Clips",
            subscribers: "2.1M subscribers",
            views: "6M views",
            viewCount: 6000000,
            date: "Jun 8, 2026",
            category: "Comedy"
        },
        {
            id: "ajab-prem",
            title: "Ajab Prem Ki Ghazab Kahani",
            file: "videos/ajab_prem.mp4",
            thumb: "thumbnails/ajab_prem.jpg",
            time: "2:20:00",
            description: "A young man's whirlwind schemes to help the girl he loves unite with her true love end up causing more chaos and laughter than he bargained for.",
            channel: "Romance Reels",
            subscribers: "1.1M subscribers",
            views: "4M views",
            viewCount: 4000000,
            date: "Jun 2, 2026",
            category: "Romance"
        },
        {
            id: "agent-sai",
            title: "Agent Sai",
            file: "videos/agent_sai.mp4",
            thumb: "thumbnails/agent_sai.jpg",
            time: "2:10:00",
            description: "A covert agent is drawn into a web of espionage and betrayal, forced to outsmart enemies at every turn to protect the mission.",
            channel: "Tech Thrillers",
            subscribers: "1.4M subscribers",
            views: "2M views",
            viewCount: 2000000,
            date: "May 27, 2026",
            category: "Thriller"
        },
        {
            id: "1920-london",
            title: "1920 London",
            file: "videos/1920_london.mp4",
            thumb: "thumbnails/1920_london.jpg",
            time: "2:08:45",
            description: "A woman living in 1920s London begins to experience terrifying supernatural occurrences as she unravels a dark secret tied to her past.",
            channel: "Horror Reels",
            subscribers: "3.2M subscribers",
            views: "6M views",
            viewCount: 6000000,
            date: "May 21, 2026",
            category: "Horror"
        },
        {
            id: "8x10-tasveer",
            title: "8 X 10 Tasveer",
            file: "videos/8x10_tasveer.mp4",
            thumb: "thumbnails/8x10_tasveer.jpg",
            time: "2:15:00",
            description: "A forest ranger with a rare ability to see the past through photographs uncovers the shocking truth behind his father's death.",
            channel: "Tech Thrillers",
            subscribers: "1.4M subscribers",
            views: "1M views",
            viewCount: 1000000,
            date: "May 15, 2026",
            category: "Thriller"
        },
        {
            id: "3am-horror",
            title: "3 AM Horror",
            file: "videos/3am.mp4",
            thumb: "thumbnails/3am.jpg",
            time: "1:40:00",
            description: "A group of friends ignore a chilling warning to stay awake and try a terrifying game at 3 AM, unleashing something that should have stayed hidden.",
            channel: "Horror Reels",
            subscribers: "3.2M subscribers",
            views: "900K views",
            viewCount: 900000,
            date: "May 9, 2026",
            category: "Horror"
        }
    ];

    window.MyTubeVideos = videos;

    // Derived unique category list (single source of truth, never hardcoded separately).
    window.MyTubeCategories = [...new Set(videos.map(v => v.category))].sort();
})();
