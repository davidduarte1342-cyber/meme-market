-- Meme Market multiplayer schema
-- Run this entire file in Supabase Dashboard > SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Trader',
  cash_balance numeric(20,2) not null default 10000 check (cash_balance >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.coins (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 30),
  ticker text not null unique check (ticker ~ '^[A-Z0-9]{2,10}$'),
  price numeric(24,10) not null default 0.001 check (price > 0),
  change_pct numeric(9,4) not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_by_name text not null default 'Meme Market',
  created_at timestamptz not null default now()
);

create table if not exists public.holdings (
  user_id uuid not null references public.profiles(id) on delete cascade,
  coin_id uuid not null references public.coins(id) on delete cascade,
  quantity numeric(28,10) not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now(),
  primary key(user_id, coin_id)
);

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  coin_id uuid not null references public.coins(id) on delete restrict,
  side text not null check (side in ('buy','sell')),
  quantity numeric(28,10) not null check (quantity > 0),
  usd_value numeric(20,2) not null check (usd_value > 0),
  price_at_trade numeric(24,10) not null,
  created_at timestamptz not null default now()
);

create table if not exists public.market_state (
  id boolean primary key default true check (id),
  last_tick_at timestamptz not null default now(),
  round_number bigint not null default 0
);
insert into public.market_state(id) values(true) on conflict do nothing;

create index if not exists trades_user_created_idx on public.trades(user_id, created_at desc);
create index if not exists holdings_user_idx on public.holdings(user_id);

-- Create a profile and starting balance automatically after email signup.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles(id, display_name, cash_balance)
  values(new.id, coalesce(nullif(new.raw_user_meta_data->>'display_name',''), split_part(new.email,'@',1)), 10000)
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Enable RLS. Users may read public market data and their own private data.
alter table public.profiles enable row level security;
alter table public.coins enable row level security;
alter table public.holdings enable row level security;
alter table public.trades enable row level security;
alter table public.market_state enable row level security;

drop policy if exists "Profiles are visible to authenticated players" on public.profiles;
create policy "Players read their own profile" on public.profiles for select to authenticated using (auth.uid() = id);
drop policy if exists "Coins are visible to everyone" on public.coins;
create policy "Coins are visible to everyone" on public.coins for select to authenticated using (true);
drop policy if exists "Players read own holdings" on public.holdings;
create policy "Players read own holdings" on public.holdings for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Players read own trades" on public.trades;
create policy "Players read own trades" on public.trades for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Market state readable" on public.market_state;
create policy "Market state readable" on public.market_state for select to authenticated using (true);

-- No direct client writes are granted. All balance/holding/market mutations go through RPC functions.
revoke insert, update, delete on public.profiles, public.coins, public.holdings, public.trades, public.market_state from anon, authenticated;
grant select on public.profiles, public.coins, public.holdings, public.trades, public.market_state to authenticated;

create or replace function public.place_trade(p_coin_id uuid, p_side text, p_amount numeric)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_coin public.coins%rowtype;
  v_cash numeric(20,2);
  v_qty numeric(28,10);
  v_value numeric(20,2);
  v_owned numeric(28,10);
begin
  if v_user is null then raise exception 'Please sign in to trade.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount greater than zero.'; end if;
  if p_side not in ('buy','sell') then raise exception 'Invalid order side.'; end if;
  select * into v_coin from public.coins where id=p_coin_id for update;
  if not found then raise exception 'Coin not found.'; end if;
  select cash_balance into v_cash from public.profiles where id=v_user for update;
  if p_side='buy' then
    v_value := round(p_amount,2);
    if v_value < 0.01 then raise exception 'Minimum order is $0.01.'; end if;
    if v_value > v_cash then raise exception 'Insufficient virtual cash.'; end if;
    v_qty := round(v_value / v_coin.price,10);
    update public.profiles set cash_balance=cash_balance-v_value where id=v_user;
    insert into public.holdings(user_id,coin_id,quantity,updated_at)
      values(v_user,p_coin_id,v_qty,now())
      on conflict(user_id,coin_id) do update set quantity=public.holdings.quantity+excluded.quantity,updated_at=now();
  else
    v_qty := round(p_amount,10);
    select quantity into v_owned from public.holdings where user_id=v_user and coin_id=p_coin_id for update;
    if coalesce(v_owned,0) < v_qty then raise exception 'Insufficient coin balance.'; end if;
    v_value := round(v_qty*v_coin.price,2);
    if v_value < 0.01 then raise exception 'Sale value is below $0.01.'; end if;
    update public.holdings set quantity=quantity-v_qty,updated_at=now() where user_id=v_user and coin_id=p_coin_id;
    update public.profiles set cash_balance=cash_balance+v_value where id=v_user;
  end if;
  insert into public.trades(user_id,coin_id,side,quantity,usd_value,price_at_trade)
  values(v_user,p_coin_id,p_side,v_qty,v_value,v_coin.price);
  return jsonb_build_object('message',upper(p_side)||' order filled', 'quantity',v_qty,'usd_value',v_value,'price',v_coin.price);
end;
$$;
revoke all on function public.place_trade(uuid,text,numeric) from public;
grant execute on function public.place_trade(uuid,text,numeric) to authenticated;

create or replace function public.create_coin(p_name text,p_ticker text)
returns uuid language plpgsql security definer set search_path = public
as $$
declare v_user uuid := auth.uid(); v_id uuid; v_display text;
begin
  if v_user is null then raise exception 'Please sign in.'; end if;
  if char_length(trim(p_name)) not between 2 and 30 then raise exception 'Coin name must be 2–30 characters.'; end if;
  if upper(trim(p_ticker)) !~ '^[A-Z0-9]{2,10}$' then raise exception 'Ticker must be 2–10 letters or numbers.'; end if;
  select display_name into v_display from public.profiles where id=v_user;
  insert into public.coins(name,ticker,price,created_by,created_by_name)
  values(trim(p_name),upper(trim(p_ticker)),0.001,v_user,v_display)
  returning id into v_id;
  return v_id;
exception when unique_violation then raise exception 'That ticker is already taken.';
end;
$$;
revoke all on function public.create_coin(text,text) from public;
grant execute on function public.create_coin(text,text) to authenticated;

-- One shared market clock. Any authenticated player can request a tick,
-- but the database enforces a 15-second cooldown for the entire game.
drop function if exists public.advance_market();
create or replace function public.advance_market(p_mode text default 'realistic')
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_last timestamptz; v_round bigint;
begin
  if auth.uid() is null then raise exception 'Please sign in.'; end if;
  if p_mode not in ('realistic','arcade') then raise exception 'Invalid market mode.'; end if;
  select last_tick_at,round_number into v_last,v_round from public.market_state where id=true for update;
  if now() < v_last + interval '15 seconds' then
    raise exception 'The shared market can advance once every 15 seconds. Try again shortly.';
  end if;
  update public.coins set
    price=greatest(0.0000001,price*(1 + (random()*(case when p_mode='arcade' then 0.28 else 0.12 end) - (case when p_mode='arcade' then 0.14 else 0.06 end)))),
    change_pct=((random()*(case when p_mode='arcade' then 0.28 else 0.12 end) - (case when p_mode='arcade' then 0.14 else 0.06 end))*100);
  update public.market_state set last_tick_at=now(),round_number=round_number+1 where id=true;
  return jsonb_build_object('message','Shared market advanced','round',v_round+1);
end;
$$;
revoke all on function public.advance_market(text) from public;
grant execute on function public.advance_market(text) to authenticated;

-- Public leaderboard is limited to authenticated users. It reports virtual portfolio value only.
-- This view intentionally exposes only leaderboard fields; base profile rows remain private.
create or replace view public.leaderboard as
select p.id as user_id, p.display_name,
  round(p.cash_balance + coalesce(sum(h.quantity*c.price),0),2) as portfolio_value
from public.profiles p
left join public.holdings h on h.user_id=p.id
left join public.coins c on c.id=h.coin_id
group by p.id,p.display_name,p.cash_balance;
grant select on public.leaderboard to authenticated;

-- Seed fictional starter coins once.
insert into public.coins(name,ticker,price,change_pct,created_by_name)
values
 ('Doge Rocket','DROCKET',0.0042,12.8,'Meme Market'),
 ('Moon Cat','MCAT',0.0081,5.4,'Meme Market'),
 ('Trumpet Frog','TFROG',0.0026,-8.2,'Meme Market'),
 ('Diamond Hands','DIAMOND',0.015,21.6,'Meme Market'),
 ('Rug Pull','RUG',0.0009,-24.5,'Meme Market')
on conflict(ticker) do nothing;

-- Realtime subscriptions used by the app.
do $$ begin
  alter publication supabase_realtime add table public.coins;
  alter publication supabase_realtime add table public.profiles;
  alter publication supabase_realtime add table public.holdings;
exception when duplicate_object then null; when undefined_object then null;
end $$;
