import React, { useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { Activity, ArrowDownRight, ArrowUpRight, CirclePlus, Coins, LogOut, RefreshCw, Trophy, Wallet } from "lucide-react";

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = url && anon ? createClient(url, anon) : null;
const money = n => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(Number(n||0));
const price = n => Number(n)<0.01 ? "$"+Number(n).toFixed(6) : "$"+Number(n).toFixed(4);

export default function App(){
  const [session,setSession]=useState(null),[profile,setProfile]=useState(null),[coins,setCoins]=useState([]),[holdings,setHoldings]=useState([]),[trades,setTrades]=useState([]),[leaders,setLeaders]=useState([]);
  const [selected,setSelected]=useState(null),[mode,setMode]=useState("realistic"),[side,setSide]=useState("buy"),[amount,setAmount]=useState("100");
  const [email,setEmail]=useState(""),[password,setPassword]=useState(""),[display,setDisplay]=useState(""),[isSignup,setIsSignup]=useState(true);
  const [coinName,setCoinName]=useState(""),[ticker,setTicker]=useState(""),[showCreate,setShowCreate]=useState(false),[notice,setNotice]=useState("Sign in or create an account to enter the shared market."),[busy,setBusy]=useState(false),[round,setRound]=useState(0);
  const configured=Boolean(supabase);

  useEffect(()=>{
    if(!supabase)return;
    supabase.auth.getSession().then(({data})=>setSession(data.session));
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,s)=>setSession(s));
    return ()=>subscription.unsubscribe();
  },[]);
  useEffect(()=>{if(session) loadAll(); else {setProfile(null);setHoldings([]);setTrades([]);}},[session]);
  useEffect(()=>{
    if(!session||!supabase)return;
    const channel=supabase.channel("shared-market")
      .on("postgres_changes",{event:"*",schema:"public",table:"coins"},()=>loadMarket())
      .on("postgres_changes",{event:"*",schema:"public",table:"profiles",filter:`id=eq.${session.user.id}`},()=>loadProfile())
      .on("postgres_changes",{event:"*",schema:"public",table:"holdings",filter:`user_id=eq.${session.user.id}`},()=>loadHoldings())
      .subscribe();
    return ()=>{supabase.removeChannel(channel)};
  },[session]);
  async function loadAll(){await Promise.all([loadProfile(),loadMarket(),loadHoldings(),loadTrades(),loadLeaders()]);}
  async function loadProfile(){const {data,error}=await supabase.from("profiles").select("*").eq("id",session.user.id).single();if(!error)setProfile(data);}
  async function loadMarket(){const {data,error}=await supabase.from("coins").select("*").order("created_at",{ascending:false});if(!error){setCoins(data||[]);setSelected(old=>old&&data?.some(c=>c.id===old)?old:(data?.[0]?.id||null));}}
  async function loadHoldings(){const {data,error}=await supabase.from("holdings").select("*,coins(name,ticker,price)").eq("user_id",session.user.id);if(!error)setHoldings(data||[]);}
  async function loadTrades(){const {data,error}=await supabase.from("trades").select("id,side,quantity,usd_value,created_at,coins(ticker)").eq("user_id",session.user.id).order("created_at",{ascending:false}).limit(10);if(!error)setTrades(data||[]);}
  async function loadLeaders(){const {data,error}=await supabase.from("leaderboard").select("*").limit(10);if(!error)setLeaders(data||[]);}
  async function authSubmit(e){e.preventDefault();setBusy(true);setNotice("");try{
    if(isSignup){const {data,error}=await supabase.auth.signUp({email,password,options:{data:{display_name:display.trim()||email.split("@")[0]}}});if(error)throw error;if(!data.session)setNotice("Account created. Check your email to confirm, then sign in.");else setNotice("Welcome to Meme Market!");}
    else{const {error}=await supabase.auth.signInWithPassword({email,password});if(error)throw error;setNotice("Welcome back!");}
  }catch(e){setNotice(e.message)}finally{setBusy(false)}}
  async function trade(e){e.preventDefault();if(!selected)return;setBusy(true);try{const {data,error}=await supabase.rpc("place_trade",{p_coin_id:selected,p_side:side,p_amount:Number(amount)});if(error)throw error;setNotice(data?.message||"Trade completed.");await Promise.all([loadProfile(),loadHoldings(),loadTrades(),loadLeaders(),loadMarket()]);}catch(e){setNotice(e.message)}finally{setBusy(false)}}
  async function createCoin(e){e.preventDefault();setBusy(true);try{const {data,error}=await supabase.rpc("create_coin",{p_name:coinName.trim(),p_ticker:ticker.trim().toUpperCase()});if(error)throw error;setCoinName("");setTicker("");setShowCreate(false);setSelected(data);setNotice("Your coin is now listed in the shared market.");await Promise.all([loadMarket(),loadLeaders()]);}catch(e){setNotice(e.message)}finally{setBusy(false)}}
  async function advance(){setBusy(true);try{const {data,error}=await supabase.rpc("advance_market",{p_mode:mode});if(error)throw error;setNotice(data?.message||"Market advanced.");setRound(v=>v+1);await loadMarket();}catch(e){setNotice(e.message)}finally{setBusy(false)}}
  async function signOut(){await supabase.auth.signOut();setNotice("Signed out.");}
  const active=coins.find(c=>c.id===selected);
  const owned=holdings.find(h=>h.coin_id===selected)?.quantity||0;
  const total=Number(profile?.cash_balance||0)+holdings.reduce((s,h)=>s+Number(h.quantity)*Number(h.coins?.price||0),0);
  const returnPct=((total-10000)/10000)*100;

  if(!configured)return <main className="setup"><h1>MEME MARKET</h1><h2>Connect your Supabase project</h2><p>Copy <code>.env.example</code> to <code>.env</code>, then add your Supabase Project URL and publishable/anon key. Follow the README setup steps.</p></main>;
  if(!session)return <main className="auth-shell"><div className="brand"><span className="brand-icon"><Coins/></span><div><b>MEME MARKET</b><small>MULTIPLAYER EXCHANGE</small></div></div><section className="auth-card"><div className="eyebrow">THE SHARED FICTIONAL MARKET</div><h1>{isSignup?"Create your trader account":"Welcome back"}</h1><p>Start with $10,000 in virtual cash. No deposits, wallets or real crypto.</p><form onSubmit={authSubmit}>
    {isSignup&&<label>Display name<input value={display} onChange={e=>setDisplay(e.target.value)} placeholder="Your trader name" maxLength={24}/></label>}
    <label>Email<input type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/></label>
    <label>Password<input type="password" required minLength={8} value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 8 characters"/></label>
    <button className="primary" disabled={busy}>{busy?"Please wait…":isSignup?"Create account":"Sign in"}</button></form>
    <button className="link" onClick={()=>setIsSignup(v=>!v)}>{isSignup?"Already have an account? Sign in":"New to Meme Market? Create an account"}</button>{notice&&<p className="notice">{notice}</p>}</section><p className="disclaimer">SIMULATION ONLY · VIRTUAL BALANCES HAVE NO CASH VALUE</p></main>;

  return <div className="shell"><header className="topbar"><div className="brand"><span className="brand-icon"><Coins/></span><div><b>MEME MARKET</b><small>MULTIPLAYER EXCHANGE</small></div></div><div className="user"><span>{profile?.display_name||session.user.email}</span><button className="icon-btn" title="Sign out" onClick={signOut}><LogOut size={17}/></button></div></header>
  <main><section className="hero"><div><div className="eyebrow"><Activity size={14}/> SHARED SIMULATED MARKET</div><h1>Trade the memes.<br/><em>Not your money.</em></h1><p>One shared market for every trader. Create fictional coins, build your portfolio and climb the leaderboard.</p></div></section>
  <section className="stats"><Stat label="Portfolio value" value={money(total)}/><Stat label="Virtual cash" value={money(profile?.cash_balance)}/><Stat label="Return since start" value={`${returnPct>=0?"+":""}${returnPct.toFixed(2)}%`} positive={returnPct>=0}/></section>
  <div className="columns"><section className="panel"><div className="heading"><div><div className="eyebrow">LIVE FOR ALL PLAYERS</div><h2>Market movers</h2></div><button className="secondary" onClick={()=>setShowCreate(v=>!v)}><CirclePlus size={15}/> Create coin</button></div>
    {coins.map(c=><button key={c.id} className={`coin ${selected===c.id?"chosen":""}`} onClick={()=>setSelected(c.id)}><span className="avatar">{c.ticker.slice(0,1)}</span><span className="coin-label"><b>{c.name}</b><small>${c.ticker}</small></span><span className="coin-val"><b>{price(c.price)}</b><small className={Number(c.change_pct)>=0?"up":"down"}>{Number(c.change_pct)>=0?"+":""}{Number(c.change_pct||0).toFixed(2)}%</small></span></button>)}
    {showCreate&&<form className="create" onSubmit={createCoin}><h3>Launch a fictional coin</h3><label>Coin name<input required maxLength="30" value={coinName} onChange={e=>setCoinName(e.target.value)} placeholder="Moon Hamster"/></label><label>Ticker<input required minLength="2" maxLength="10" value={ticker} onChange={e=>setTicker(e.target.value)} placeholder="HAMMY"/></label><button className="primary" disabled={busy}>Launch coin</button></form>}
  </section>
  <section className="panel"><div className="heading"><div><div className="eyebrow">TRADING TERMINAL</div><h2>{active?.name||"Select a coin"}</h2><small className="muted">{active?"$"+active.ticker:""}</small></div><div className="modes"><button className={mode==="realistic"?"active":""} onClick={()=>setMode("realistic")}>Realistic</button><button className={mode==="arcade"?"active":""} onClick={()=>setMode("arcade")}>Arcade</button></div></div>
    {active&&<><div className="big-price">{price(active.price)}</div><div className="muted">Shared simulated price · {active.created_by_name?"Created by "+active.created_by_name:"Community coin"}</div><div className="chart-placeholder"><span>SHARED MARKET PRICE</span><Activity size={65}/><small>Price history is updated as market rounds advance.</small></div>
    <form className="order" onSubmit={trade}><div className="tabs"><button type="button" className={side==="buy"?"buy active":""} onClick={()=>setSide("buy")}>Buy</button><button type="button" className={side==="sell"?"sell active":""} onClick={()=>setSide("sell")}>Sell</button></div><label>{side==="buy"?"Amount in virtual USD":"Number of coins to sell"}<input type="number" min="0.00000001" step="any" required value={amount} onChange={e=>setAmount(e.target.value)}/></label><div className="muted">Owned: {Number(owned).toFixed(4)} {active.ticker}</div><button className={side==="buy"?"primary":"danger"} disabled={busy}>{busy?"Processing…":side==="buy"?"Buy "+active.ticker:"Sell "+active.ticker}</button></form></>}
  </section></div>
  <div className="columns lower"><section className="panel"><div className="heading"><div><div className="eyebrow">YOUR POSITIONS</div><h2>Portfolio</h2></div><Wallet/></div>{holdings.filter(h=>Number(h.quantity)>0).length?holdings.filter(h=>Number(h.quantity)>0).map(h=><div className="line" key={h.coin_id}><span>{h.coins?.name}<small>{Number(h.quantity).toFixed(3)} {h.coins?.ticker}</small></span><b>{money(Number(h.quantity)*Number(h.coins?.price||0))}</b></div>):<p className="muted">No positions yet. Make your first trade.</p>}</section>
  <section className="panel"><div className="heading"><div><div className="eyebrow">GLOBAL COMPETITION</div><h2><Trophy size={18}/> Leaderboard</h2></div><button className="icon-btn" onClick={loadLeaders}><RefreshCw size={15}/></button></div>{leaders.map((l,i)=><div className="line" key={l.user_id}><span>#{i+1} {l.display_name}<small>Trader</small></span><b>{money(l.portfolio_value)}</b></div>)}</section></div>
  <section className="panel recent"><div className="heading"><div><div className="eyebrow">YOUR ACTIVITY</div><h2>Recent trades</h2></div></div>{trades.length?trades.map(t=><div className="line" key={t.id}><span className={t.side==="buy"?"up":"down"}>{t.side.toUpperCase()} {t.coins?.ticker}<small>{Number(t.quantity).toFixed(3)} coins · {new Date(t.created_at).toLocaleString()}</small></span><b>{money(t.usd_value)}</b></div>):<p className="muted">Your trades will appear here.</p>}</section>
  <section className="market-control"><div><div className="eyebrow">MARKET ENGINE</div><h2>Advance shared market</h2><p>{mode==="arcade"?"Arcade mode uses higher simulated volatility.":"Realistic mode uses more moderate simulated volatility."} All players see the same resulting prices.</p></div><button className="primary" onClick={advance} disabled={busy}><RefreshCw size={16}/> Advance market</button></section>
  <p className="notice">{notice}</p><p className="disclaimer">FICTIONAL SIMULATION ONLY. No real tokens, deposits, withdrawals, cash-out or investment returns. Market movement is game data.</p>
  </main></div>;
}
function Stat({label,value,positive}){return <div className="stat"><small>{label}</small><b className={positive===undefined?"":positive?"up":"down"}>{value}</b></div>}
