import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import {Restaurant,User,Table,Category,MenuItem,Order,Subscription,Notification,SubscriptionPayment,SuperAdminNotification,Coupon,Review,SupportTicket} from './models.js';
import {protect,tokenFor} from './auth.js';import {sendMail} from './mailer.js';
import {upload,uploadToCloudinary} from './upload.js';
import {translateTexts,SUPPORTED_LANGUAGES} from './translate.js';

  import path from 'path';
  import { fileURLToPath } from 'url';
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
 dotenv.config({ path: path.join(__dirname, '../.env') }); 
console.log(process.env.MONGODB_URI);

if(process.env.NODE_ENV==='production'){
  const missing=['JWT_SECRET','MONGODB_URI'].filter(k=>!process.env[k]);
  if(missing.length){console.error(`Missing required environment variable(s): ${missing.join(', ')}`);process.exit(1)}
}

const app=express();
app.set('trust proxy',1); // needed for correct req.protocol/IP behind a reverse proxy (Render/Heroku/Nginx)
app.use(helmet({crossOriginResourcePolicy:{policy:'cross-origin'}})); // cross-origin so uploaded images can be <img>'d from the frontend's own origin
app.use(compression());

// CORS: comma-separated ALLOWED_ORIGINS in production (e.g. "https://qrdine.com,https://*.qrdine.com").
// Left unset, everything is allowed, which is fine for local dev but should always be locked down in prod.
const allowedOrigins=(process.env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
app.use(cors({origin:(origin,cb)=>{
  if(!origin||!allowedOrigins.length)return cb(null,true);
  const ok=allowedOrigins.some(o=>o===origin||(o.includes('*')&&new RegExp('^'+o.replace(/\./g,'\\.').replace(/\*/g,'.*')+'$').test(origin)));
  cb(ok?null:new Error('Not allowed by CORS'),ok);
}}));
app.use(express.json({limit:'2mb'}));

// Basic abuse protection — generous limits so real usage is never affected, but bots hammering
// the API (especially login) get slowed down.
app.use('/api/',rateLimit({windowMs:15*60*1000,max:600,standardHeaders:true,legacyHeaders:false}));
app.use('/api/auth/login',rateLimit({windowMs:15*60*1000,max:20,standardHeaders:true,legacyHeaders:false,message:{message:'Too many login attempts. Please try again later.'}}));
// Feature: on-the-fly menu translation — each call can fan out into many translation-API requests, so
// it gets a tighter limit than the general API budget above.
app.use('/api/public/menu/:slug/:token/translate',rateLimit({windowMs:10*60*1000,max:30,standardHeaders:true,legacyHeaders:false,message:{message:'Too many translation requests. Please try again shortly.'}}));

// Serve uploaded images. Cached aggressively since filenames are random/unique per upload.

const A=f=>(q,s,n)=>Promise.resolve(f(q,s,n)).catch(e=>s.status(400).json({message:e.message||'Request failed'}));
const PLAN_AMOUNT=999; // monthly subscription price (INR) that a restaurant admin pays the super admin
const PLAN_AMOUNT_ANNUAL=9999; // annual plan price (INR) — ~2 months free vs paying monthly
const MONTH_MS=2592000000; // 30 days
const YEAR_MS=31536000000; // 365 days
const planAmount=t=>t==='annual'?PLAN_AMOUNT_ANNUAL:PLAN_AMOUNT;
const planDuration=t=>t==='annual'?YEAR_MS:MONTH_MS;
const PAY_WINDOW_MS=10*60*1000; // 10 minutes to pay at counter before an order auto-cancels
const genTxnId=()=>'TXN'+Date.now().toString(36).toUpperCase()+crypto.randomBytes(3).toString('hex').toUpperCase();
const shortId=id=>String(id).slice(-6).toUpperCase();
const INSTANT_SUPPORT_FEE=199; // INR — restaurant admin pays this to open an instant-chat support ticket with the super admin
const genToken=()=>'TKT-'+crypto.randomBytes(4).toString('hex').toUpperCase();
const genCouponCode=()=>'SQR'+crypto.randomBytes(3).toString('hex').toUpperCase();

/* ---------------- Subdomain resolution (Feature: restaurant-admin logs in only on their own subdomain) ----------------
   Each restaurant's `slug` doubles as its login subdomain, e.g. slug "sudds" -> sudds.<ROOT_DOMAIN>.
   We derive the subdomain the browser is actually on from the Origin/Referer header (can't be spoofed by
   editing a request body the way a plain form field could), and fall back to an explicit `subdomain` field
   in the request body only for local/dev setups that don't have wildcard DNS configured. */
const ROOT_DOMAIN = (process.env.ROOT_DOMAIN || '').toLowerCase();
const IS_NETLIFY = ROOT_DOMAIN.endsWith('.netlify.app');
function extractSubdomain(hostname) {
  if (!hostname) return null;

  hostname = hostname.split(':')[0].toLowerCase();

  // Localhost
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return null;
  }

  if (hostname.endsWith('.localhost')) {
    const sub = hostname.replace('.localhost', '');
    return sub && sub !== 'www' ? sub : null;
  }

  // Netlify
  if (IS_NETLIFY) {
    return null;
  }

  // Production
  if (ROOT_DOMAIN) {
    if (hostname === ROOT_DOMAIN || hostname === `www.${ROOT_DOMAIN}`) {
      return null;
    }

    if (hostname.endsWith(`.${ROOT_DOMAIN}`)) {
      const rest = hostname.slice(
        0,
        -(ROOT_DOMAIN.length + 1)
      );

      if (!rest || rest === 'www') return null;

      return rest.split('.').pop();
    }
  }

  return null;
}
function resolveSubdomain(req) {
  const origin = req.headers.origin || req.headers.referer;

  if (origin) {
    try {
      const sub = extractSubdomain(new URL(origin).hostname);

      if (sub) return sub;
    } catch {}
  }

  // Netlify / localhost fallback
  if (req.query.subdomain) {
    return String(req.query.subdomain).trim().toLowerCase();
  }

  if (req.body?.subdomain) {
    return String(req.body.subdomain).trim().toLowerCase();
  }

  return null;
}

app.get('/api/health',(q,s)=>s.json({ok:true}));
app.get('/api/config',(q,s)=>s.json({rootDomain:ROOT_DOMAIN}));

// Image upload — used by every "logo / banner / item photo" field in the admin & super-admin UIs
// (drag-and-drop or file picker on the frontend) instead of asking admins to paste an image URL.
// Requires a logged-in admin (either role); returns the public URL to store on the record.
app.post('/api/uploads',protect(),(q,s)=>{
  upload.single('image')(q,s,async err=>{
    if(err)return s.status(400).json({message:err.message||'Upload failed'});
    if(!q.file)return s.status(400).json({message:'No image file provided'});
    try{
      const result=await uploadToCloudinary(q.file.buffer);
      s.status(201).json({url:result.secure_url,filename:result.public_id});
    }catch (e) {
  console.error("Cloudinary Error:", e);

  s.status(500).json({
    message: e.message,
    error: e
  });
}
  });
});

app.post('/api/auth/login',A(async(q,s)=>{
  const u=await User.findOne({email:q.body.email});
  if(!u||!await bcrypt.compare(q.body.password,u.password))return s.status(401).json({message:'Invalid email or password'});
  if(q.body.role!==u.role)return s.status(403).json({message:'This account does not have that access'});
  if(u.role==='restaurant_admin'){
    const restaurant=await Restaurant.findById(u.restaurant);
    if(!restaurant)return s.status(403).json({message:'Restaurant account not found'});
    // Feature: when a super admin disables a restaurant, its admin login is blocked outright (distinct from
    // a merely-expired subscription, which still allows sign-in so the owner can pay and renew).
    if(!restaurant.active)return s.status(403).json({message:'This restaurant has been disabled by the ServeQR admin. Please contact support.'});
    const sub=resolveSubdomain(q);
    if(!sub||sub!==restaurant.slug.toLowerCase())return s.status(403).json({message:`Please sign in from your restaurant's own subdomain: ${restaurant.slug}.${ROOT_DOMAIN||'yourdomain.com'}`});
  }
  if(u.role==='super_admin'){
    const sub=resolveSubdomain(q);
    if(sub)return s.status(403).json({message:'Super admin sign-in is only available on the main domain, not a restaurant subdomain.'});
  }
  s.json({token:tokenFor(u),user:u})
}));

/* ---------------- PUBLIC (customer-facing) ---------------- */
app.get('/api/public/menu/:slug/:token',A(async(q,s)=>{const restaurant=await Restaurant.findOne({slug:q.params.slug}),table=await Table.findOne({restaurant:restaurant?._id,qrToken:q.params.token});if(!restaurant||!table)return s.status(404).json({message:'Menu not found'});s.json({restaurant,table,unavailable:!restaurant.active||restaurant.subscriptionStatus==='inactive'||restaurant.expiryDate<new Date(),categories:await Category.find({restaurant:restaurant._id}).sort('sort'),items:await MenuItem.find({restaurant:restaurant._id}).populate('category')})}));

// Feature: customer applies a coupon at checkout. Shared logic used both by the standalone "validate" check
// (so the UI can show the discount before placing the order) and by order placement itself.
async function computeCoupon(restaurantId,code,subtotal){
  if(!code)return {discount:0,coupon:null};
  const coupon=await Coupon.findOne({restaurant:restaurantId,code:String(code).trim().toUpperCase()});
  if(!coupon)throw Error('Invalid coupon code');
  if(!coupon.active)throw Error('This coupon is no longer active');
  if(coupon.expiryDate&&new Date(coupon.expiryDate)<new Date())throw Error('This coupon has expired');
  if(coupon.usageLimit&&coupon.usedCount>=coupon.usageLimit)throw Error('This coupon has reached its usage limit');
  if(subtotal<(coupon.minOrderValue||0))throw Error(`Minimum order value for this coupon is ₹${coupon.minOrderValue}`);
  let discount=coupon.discountType==='flat'?coupon.discountValue:Math.round(subtotal*(coupon.discountValue/100));
  if(coupon.maxDiscount)discount=Math.min(discount,coupon.maxDiscount);
  discount=Math.min(discount,subtotal);
  return {discount,coupon};
}
// Feature: on-the-fly menu translation. Unlike the admin-curated `restaurant.languages` list (which
// only offers languages an admin has manually pre-filled), this lets the customer translate into ANY
// supported language themselves. Only categories/items missing a cached translation for that language
// are actually sent to the translation provider — everyone after the first customer to pick a language
// gets it for free from the cache.
app.post('/api/public/menu/:slug/:token/translate',A(async(q,s)=>{
  const lang=String(q.body?.lang||'');
  if(!SUPPORTED_LANGUAGES.has(lang))throw Error('Choose a valid language');
  const restaurant=await Restaurant.findOne({slug:q.params.slug}),table=await Table.findOne({restaurant:restaurant?._id,qrToken:q.params.token});
  if(!restaurant||!table)return s.status(404).json({message:'Menu not found'});

  const [categories,items]=await Promise.all([
    Category.find({restaurant:restaurant._id}).sort('sort'),
    MenuItem.find({restaurant:restaurant._id}).populate('category'),
  ]);
  if(lang==='en')return s.json({categories,items}); // base language — nothing to translate

  const catsToTranslate=categories.filter(c=>!c.translations?.[lang]?.name);
  const itemsToTranslate=items.filter(i=>!i.translations?.[lang]?.name);
  const texts=[...catsToTranslate.map(c=>c.name||''),...itemsToTranslate.flatMap(i=>[i.name||'',i.description||''])];

  if(texts.length){
    const out=await translateTexts(texts,lang);
    let p=0;
    for(const c of catsToTranslate){
      const name=out[p++]||c.name;
      c.translations={...(c.translations||{}),[lang]:{name}};
    }
    for(const i of itemsToTranslate){
      const name=out[p++]||i.name,description=out[p++]||i.description;
      i.translations={...(i.translations||{}),[lang]:{name,description}};
    }
    await Promise.all([...catsToTranslate.map(c=>c.save()),...itemsToTranslate.map(i=>i.save())]);
  }
  s.json({categories,items});
}));

app.post('/api/public/coupons/validate',A(async(q,s)=>{
  const {restaurantId,code,subtotal}=q.body;
  const {discount,coupon}=await computeCoupon(restaurantId,code,Number(subtotal)||0);
  s.json({valid:true,code:coupon.code,description:coupon.description,discount,total:Math.max(0,(Number(subtotal)||0)-discount)});
}));

// Feature: half/full portion pricing — resolves the correct price (and a display name suffix) for a cart
// line server-side, so a customer can never manipulate the price by editing the request body.
function resolvePortionLine(m,x){
  if(!m)throw Error('An item is unavailable');
  const wantsHalf=m.hasPortions&&x.portion==='half';
  if(wantsHalf&&(m.halfPrice==null))throw Error(`${m.name}: half portion is not available`);
  const price=wantsHalf?m.halfPrice:m.price;
  const portion=m.hasPortions?(wantsHalf?'half':'full'):undefined;
  const name=portion?`${m.name} (${portion==='half'?'Half':'Full'})`:m.name;
  return {menuItem:m._id,name,price,quantity:x.quantity,portion};
}
app.post('/api/public/orders',A(async(q,s)=>{
  const {restaurantId,tableId,items,customerName,phone,instructions,paymentMethod,couponCode}=q.body,r=await Restaurant.findById(restaurantId);
  if(!r?.active||r.subscriptionStatus==='inactive'||r.expiryDate<new Date())throw Error('Service unavailable');
  const table=await Table.findById(tableId);
  const menu=await MenuItem.find({_id:{$in:items.map(x=>x.menuItem)},available:true});
  const lines=items.map(x=>resolvePortionLine(menu.find(y=>String(y._id)===x.menuItem),x));
  const subtotal=lines.reduce((a,x)=>a+x.price*x.quantity,0);
  const {discount,coupon}=await computeCoupon(restaurantId,couponCode,subtotal);
  const total=subtotal-discount;
  const isOnline=paymentMethod==='online';
  const order=await Order.create({restaurant:restaurantId,table:tableId,items:lines,customerName,phone,instructions,subtotal,discount,couponCode:coupon?.code,total,paymentMethod,
    paymentStatus:isOnline?'paid':'unpaid',
    status:isOnline?'pending':'awaiting_payment',
    paymentDueAt:isOnline?undefined:new Date(Date.now()+PAY_WINDOW_MS),
    transactionId:isOnline?genTxnId():undefined});
  if(coupon){coupon.usedCount+=1;await coupon.save()}
  await Notification.create({restaurant:restaurantId,order:order._id,table:table?._id,
    type:isOnline?'online_payment':'table_order',
    title:isOnline?`Online payment received · ${table?.name||'Table'}`:`New order from ${table?.name||'Table'}`,
    message:isOnline?`₹${total} paid online · Txn ${order.transactionId}`:`${lines.length} item(s) ordered · pay at counter within 10 minutes to confirm`});
  s.status(201).json({orderNumber:shortId(order._id),estimatedTime:'20 mins',order,orderId:order._id});
}));

// Feature: customer leaves a quick rating + email when their order is completed, before being sent to the
// restaurant's Google review page — gives the restaurant admin an email to target with a thank-you coupon.
app.post('/api/public/reviews',A(async(q,s)=>{
  const {orderId,rating,comment,email,customerName}=q.body,order=await Order.findById(orderId);
  if(!order)throw Error('Order not found');
  if(order.status!=='completed')throw Error('Reviews can only be left once an order is delivered');
  const review=await Review.create({restaurant:order.restaurant,order:order._id,customerName:customerName||order.customerName,email,rating:Math.max(1,Math.min(5,Number(rating)||5)),comment});
  s.status(201).json(review);
}));

app.get('/api/public/orders/:id/status',A(async(q,s)=>{
  const order=await Order.findById(q.params.id).populate('table').populate('restaurant','name logo googleReviewUrl');
  if(!order)return s.status(404).json({message:'Order not found'});
  s.json({orderId:order._id,orderNumber:shortId(order._id),status:order.status,paymentStatus:order.paymentStatus,paymentMethod:order.paymentMethod,paymentDueAt:order.paymentDueAt,total:order.total,transactionId:order.transactionId,items:order.items,table:order.table,restaurant:order.restaurant,createdAt:order.createdAt});
}));

/* ---------------- RESTAURANT ADMIN ---------------- */
app.get('/api/admin/dashboard',protect('restaurant_admin'),A(async(q,s)=>{
  const day=new Date();day.setHours(0,0,0,0);
  const [o,r]=await Promise.all([Order.find({restaurant:q.user.restaurant,createdAt:{$gte:day}}),Restaurant.findById(q.user.restaurant)]);
  const n=x=>o.filter(y=>y.status===x).length;
  const revenueToday=o.filter(y=>y.paymentStatus==='paid').reduce((a,y)=>a+y.total,0);
  const daysLeft=r.expiryDate?Math.ceil((new Date(r.expiryDate)-new Date())/86400000):null;
  s.json({today:o.length,pending:n('pending'),preparing:n('preparing'),completed:n('completed'),awaitingPayment:n('awaiting_payment'),revenueToday,
    subscription:{status:r.subscriptionStatus,active:r.active,expiryDate:r.expiryDate,daysLeft}});
}));

app.get('/api/admin/orders',protect('restaurant_admin'),A(async(q,s)=>{
  const filter={restaurant:q.user.restaurant};
  if(q.query.scope==='history')filter.status={$in:['completed','cancelled']};
  else if(q.query.scope==='active')filter.status={$in:['awaiting_payment','pending','preparing','ready']};
  if(q.query.status)filter.status=q.query.status;
  if(q.query.paymentMethod)filter.paymentMethod=q.query.paymentMethod;
  if(q.query.from||q.query.to){filter.createdAt={};if(q.query.from)filter.createdAt.$gte=new Date(q.query.from);if(q.query.to)filter.createdAt.$lte=new Date(new Date(q.query.to).getTime()+86400000)}
  s.json(await Order.find(filter).populate('table').sort('-createdAt'));
}));

app.patch('/api/admin/orders/:id',protect('restaurant_admin'),A(async(q,s)=>{
  const order=await Order.findOne({_id:q.params.id,restaurant:q.user.restaurant});
  if(!order)throw Error('Order not found');
  if(order.status==='awaiting_payment'&&q.body.status&&q.body.status!=='cancelled')throw Error('Mark payment as received before updating this order');
  order.status=q.body.status;await order.save();s.json(await order.populate('table'));
}));

// Feature: pay-by-counter orders start "unpaid"; admin confirms once the guest actually pays at the counter.
app.patch('/api/admin/orders/:id/payment',protect('restaurant_admin'),A(async(q,s)=>{
  const order=await Order.findOne({_id:q.params.id,restaurant:q.user.restaurant}).populate('table');
  if(!order)throw Error('Order not found');
  if(order.paymentStatus==='paid')throw Error('This order is already marked as paid');
  if(order.status==='cancelled')throw Error('This order was already cancelled');
  order.paymentStatus='paid';order.status='pending';order.paymentDueAt=undefined;await order.save();
  await Notification.create({restaurant:q.user.restaurant,order:order._id,table:order.table?._id,type:'payment_confirmed',
    title:`Payment confirmed · ${order.table?.name||'Table'}`,message:`Counter payment received — order sent to kitchen`});
  s.json(order);
}));

app.post('/api/admin/counter-orders',protect('restaurant_admin'),A(async(q,s)=>{const {tableId,items,paymentMethod,customerName}=q.body,table=await Table.findOne({_id:tableId,restaurant:q.user.restaurant});if(!table)throw Error('Choose a valid table');if(!['cash','upi'].includes(paymentMethod))throw Error('Choose Cash or UPI');const menu=await MenuItem.find({_id:{$in:items.map(x=>x.menuItem)},restaurant:q.user.restaurant,available:true});const lines=items.map(x=>resolvePortionLine(menu.find(y=>String(y._id)===x.menuItem),x)),total=lines.reduce((a,x)=>a+x.price*x.quantity,0);const order=await Order.create({restaurant:q.user.restaurant,table:table._id,customerName:customerName||'Counter guest',items:lines,total,paymentMethod,paymentStatus:'paid',status:'pending'});s.status(201).json({order:await order.populate('table')})}));

/* Notifications (Features: table-scan order + online payment alerts) */
app.get('/api/admin/notifications',protect('restaurant_admin'),A(async(q,s)=>{
  const [notifications,unread]=await Promise.all([
    Notification.find({restaurant:q.user.restaurant}).sort('-createdAt').limit(40).populate('table'),
    Notification.countDocuments({restaurant:q.user.restaurant,read:false})]);
  s.json({notifications,unread});
}));
app.patch('/api/admin/notifications/:id/read',protect('restaurant_admin'),A(async(q,s)=>s.json(await Notification.findOneAndUpdate({_id:q.params.id,restaurant:q.user.restaurant},{read:true},{new:true}))));
app.post('/api/admin/notifications/read-all',protect('restaurant_admin'),A(async(q,s)=>{await Notification.updateMany({restaurant:q.user.restaurant,read:false},{read:true});s.json({ok:true})}));

app.get('/api/admin/menu',protect('restaurant_admin'),A(async(q,s)=>s.json({categories:await Category.find({restaurant:q.user.restaurant}).sort('sort'),items:await MenuItem.find({restaurant:q.user.restaurant}).populate('category')})));
app.post('/api/admin/categories',protect('restaurant_admin'),A(async(q,s)=>s.json(await Category.create({...q.body,restaurant:q.user.restaurant}))));
app.patch('/api/admin/categories/:id',protect('restaurant_admin'),A(async(q,s)=>s.json(await Category.findOneAndUpdate({_id:q.params.id,restaurant:q.user.restaurant},q.body,{new:true}))));
app.delete('/api/admin/categories/:id',protect('restaurant_admin'),A(async(q,s)=>{await Category.deleteOne({_id:q.params.id,restaurant:q.user.restaurant});s.sendStatus(204)}));
app.post('/api/admin/items',protect('restaurant_admin'),A(async(q,s)=>s.json(await MenuItem.create({...q.body,restaurant:q.user.restaurant}))));
app.patch('/api/admin/items/:id',protect('restaurant_admin'),A(async(q,s)=>s.json(await MenuItem.findOneAndUpdate({_id:q.params.id,restaurant:q.user.restaurant},q.body,{new:true}))));
app.delete('/api/admin/items/:id',protect('restaurant_admin'),A(async(q,s)=>{await MenuItem.deleteOne({_id:q.params.id,restaurant:q.user.restaurant});s.sendStatus(204)}));

/* Tables — admin can add/remove tables, and sees a "new order" badge per table (Feature: table-scan notification) */
app.get('/api/admin/tables',protect('restaurant_admin'),A(async(q,s)=>{
  const [tables,restaurant,activeOrders]=await Promise.all([
    Table.find({restaurant:q.user.restaurant}).sort('number'),
    Restaurant.findById(q.user.restaurant),
    Order.find({restaurant:q.user.restaurant,status:{$in:['awaiting_payment','pending','preparing','ready']}})]);
  const withStatus=tables.map(t=>{
    const orders=activeOrders.filter(o=>String(o.table)===String(t._id));
    return {...t.toObject(),activeOrderCount:orders.length,hasNewOrder:orders.some(o=>['pending','awaiting_payment'].includes(o.status))};
  });
  s.json({tables:withStatus,restaurantSlug:restaurant.slug,restaurantName:restaurant.name});
}));
app.post('/api/admin/tables',protect('restaurant_admin'),A(async(q,s)=>s.json(await Table.create({...q.body,restaurant:q.user.restaurant,qrToken:crypto.randomBytes(5).toString('hex')}))));
app.patch('/api/admin/tables/:id',protect('restaurant_admin'),A(async(q,s)=>s.json(await Table.findOneAndUpdate({_id:q.params.id,restaurant:q.user.restaurant},q.body,{new:true}))));
app.delete('/api/admin/tables/:id',protect('restaurant_admin'),A(async(q,s)=>{await Table.deleteOne({_id:q.params.id,restaurant:q.user.restaurant});s.sendStatus(204)}));

/* Restaurant profile + customizable bill settings (Feature 6) */
app.get('/api/admin/restaurant',protect('restaurant_admin'),A(async(q,s)=>s.json(await Restaurant.findById(q.user.restaurant))));
app.patch('/api/admin/restaurant',protect('restaurant_admin'),A(async(q,s)=>{
  const {phone,address,logo,billSettings,languages}=q.body;
  const update={};if(phone!==undefined)update.phone=phone;if(address!==undefined)update.address=address;if(logo!==undefined)update.logo=logo;if(billSettings!==undefined)update.billSettings=billSettings;
  // Feature: multi-language menu — English always stays enabled as the base language.
  if(languages!==undefined)update.languages=Array.from(new Set(['en',...(Array.isArray(languages)?languages:[])]));
  s.json(await Restaurant.findByIdAndUpdate(q.user.restaurant,update,{new:true}));
}));

/* Analytics (Feature 8) */
app.get('/api/admin/analytics',protect('restaurant_admin'),A(async(q,s)=>{
  const range=q.query.range||'today',start=new Date();
  if(range==='today')start.setHours(0,0,0,0);else if(range==='week')start.setDate(start.getDate()-7);else if(range==='month')start.setDate(start.getDate()-30);else start.setFullYear(2000);
  const orders=await Order.find({restaurant:q.user.restaurant,createdAt:{$gte:start}});
  const paidOrders=orders.filter(o=>o.paymentStatus==='paid');
  const revenue=paidOrders.reduce((a,o)=>a+o.total,0);
  const itemMap={};orders.forEach(o=>o.items.forEach(i=>{itemMap[i.name]=(itemMap[i.name]||0)+i.quantity}));
  const itemStats=Object.entries(itemMap).map(([name,qty])=>({name,qty})).sort((a,b)=>b.qty-a.qty);
  const paymentBreakdown={};paidOrders.forEach(o=>{paymentBreakdown[o.paymentMethod]=(paymentBreakdown[o.paymentMethod]||0)+o.total});
  const statusBreakdown={};orders.forEach(o=>{statusBreakdown[o.status]=(statusBreakdown[o.status]||0)+1});
  const hourly=Array.from({length:24},()=>0);orders.forEach(o=>{hourly[new Date(o.createdAt).getHours()]++});
  const peakHour=hourly.reduce((best,v,i)=>v>hourly[best]?i:best,0);
  const peakHourLabel=orders.length?`${peakHour%12||12} ${peakHour<12?'AM':'PM'} – ${(peakHour+1)%12||12} ${peakHour+1<12||peakHour+1===24?'AM':'PM'}`:'—';

  // Feature: repeat-customer rate — of the guests (by phone number) who ordered in this period, what
  // share had also ordered here at least once *before* this period started. A phone number is the only
  // stable identifier we have for a guest (there's no customer account system for table ordering).
  const phoneHistory=await Order.find({restaurant:q.user.restaurant,phone:{$exists:true,$ne:''}}).select('phone createdAt').lean();
  const firstOrderByPhone={};phoneHistory.forEach(o=>{if(!firstOrderByPhone[o.phone]||o.createdAt<firstOrderByPhone[o.phone])firstOrderByPhone[o.phone]=o.createdAt});
  const phonesInRange=new Set(orders.filter(o=>o.phone).map(o=>o.phone));
  const repeatCustomers=[...phonesInRange].filter(p=>firstOrderByPhone[p]&&firstOrderByPhone[p]<start).length;
  const repeatCustomerRate=phonesInRange.size?Math.round((repeatCustomers/phonesInRange.size)*100):0;

  s.json({range,orderCount:orders.length,revenue,avgOrderValue:paidOrders.length?Math.round(revenue/paidOrders.length):0,
    topItems:itemStats.slice(0,5),lowItems:itemStats.slice(-5).reverse().filter(x=>!itemStats.slice(0,5).includes(x)),
    paymentBreakdown,statusBreakdown,hourly,peakHourLabel,cancelledCount:orders.filter(o=>o.status==='cancelled').length,
    uniqueCustomers:phonesInRange.size,repeatCustomers,repeatCustomerRate});
}));

/* App subscription — restaurant admin pays the super admin (Features 1 & 7) */
app.get('/api/admin/subscription',protect('restaurant_admin'),A(async(q,s)=>{
  const [restaurant,payments]=await Promise.all([Restaurant.findById(q.user.restaurant),SubscriptionPayment.find({restaurant:q.user.restaurant}).sort('-createdAt')]);
  const daysLeft=restaurant.expiryDate?Math.ceil((new Date(restaurant.expiryDate)-new Date())/86400000):null;
  s.json({restaurant,payments,planAmount:PLAN_AMOUNT,planAmounts:{monthly:PLAN_AMOUNT,annual:PLAN_AMOUNT_ANNUAL},daysLeft});
}));
app.post('/api/admin/subscription/pay',protect('restaurant_admin'),A(async(q,s)=>{
  const {method}=q.body;if(!['upi','cash','online'].includes(method))throw Error('Choose a payment method');
  const plan=q.body.planType==='annual'?'annual':'monthly';
  const amount=planAmount(plan),isOnline=method==='online';
  const periodStart=new Date(),periodEnd=new Date(periodStart.getTime()+planDuration(plan));
  const payment=await SubscriptionPayment.create({restaurant:q.user.restaurant,amount,method,planType:plan,periodStart,periodEnd,status:isOnline?'confirmed':'pending',transactionId:isOnline?genTxnId():undefined});
  if(isOnline){
    await Restaurant.findByIdAndUpdate(q.user.restaurant,{active:true,subscriptionStatus:'active',planType:plan,subscriptionStartDate:periodStart,expiryDate:periodEnd});
    await Subscription.findOneAndUpdate({restaurant:q.user.restaurant},{status:'active',expiryDate:periodEnd},{upsert:true});
  }
  // Feature: alert the super admin whenever a restaurant admin subscribes/renews, with the plan period they signed up for.
  const restaurant=await Restaurant.findById(q.user.restaurant);
  await SuperAdminNotification.create({restaurant:q.user.restaurant,type:'subscription_purchase',
    title:`${restaurant?.name||'A restaurant'} subscribed · ${plan} plan`,
    message:`₹${amount} via ${method.toUpperCase()} · ${periodStart.toLocaleDateString()} → ${periodEnd.toLocaleDateString()} · ${isOnline?'active immediately':'awaiting your payment confirmation'}`});
  s.status(201).json(payment);
}));

/* Coupons — restaurant admin creates discount coupons and can email them to specific reviewers (Feature: coupons) */
app.get('/api/admin/coupons',protect('restaurant_admin'),A(async(q,s)=>s.json(await Coupon.find({restaurant:q.user.restaurant}).sort('-createdAt'))));
app.post('/api/admin/coupons',protect('restaurant_admin'),A(async(q,s)=>{
  const {code,description,discountType,discountValue,minOrderValue,maxDiscount,expiryDate,usageLimit}=q.body;
  if(!discountValue||discountValue<=0)throw Error('Enter a valid discount value');
  const coupon=await Coupon.create({restaurant:q.user.restaurant,code:(code||genCouponCode()).toUpperCase(),description,
    discountType:discountType==='flat'?'flat':'percent',discountValue,minOrderValue:minOrderValue||0,maxDiscount:maxDiscount||undefined,
    expiryDate:expiryDate||undefined,usageLimit:usageLimit||undefined});
  s.status(201).json(coupon);
}));
app.patch('/api/admin/coupons/:id',protect('restaurant_admin'),A(async(q,s)=>s.json(await Coupon.findOneAndUpdate({_id:q.params.id,restaurant:q.user.restaurant},q.body,{new:true}))));
app.delete('/api/admin/coupons/:id',protect('restaurant_admin'),A(async(q,s)=>{await Coupon.deleteOne({_id:q.params.id,restaurant:q.user.restaurant});s.sendStatus(204)}));
// Emails a coupon to a chosen list of addresses (typically customers who left a review) — simulated if no SMTP is configured.
app.post('/api/admin/coupons/:id/send',protect('restaurant_admin'),A(async(q,s)=>{
  const coupon=await Coupon.findOne({_id:q.params.id,restaurant:q.user.restaurant});if(!coupon)throw Error('Coupon not found');
  const emails=(q.body.emails||[]).map(e=>String(e).trim()).filter(Boolean);
  if(!emails.length)throw Error('Choose at least one recipient');
  const restaurant=await Restaurant.findById(q.user.restaurant);
  const discountText=coupon.discountType==='flat'?`₹${coupon.discountValue} off`:`${coupon.discountValue}% off`;
  const results=[];
  for(const email of emails){
    await sendMail({to:email,subject:`A little thank-you from ${restaurant.name} — ${discountText}`,
      text:`Hi! Thanks for your review. Use code ${coupon.code} for ${discountText} on your next order at ${restaurant.name}.${coupon.expiryDate?` Valid until ${new Date(coupon.expiryDate).toLocaleDateString()}.`:''}`});
    coupon.sentTo.push({email});results.push(email);
  }
  await coupon.save();
  s.json({sent:results,coupon});
}));

/* Reviews — captured from customers at order completion, used to target coupon emails (Feature: coupons) */
app.get('/api/admin/reviews',protect('restaurant_admin'),A(async(q,s)=>s.json(await Review.find({restaurant:q.user.restaurant}).sort('-createdAt'))));

/* Support — restaurant admin generates a token to reach the super admin; instant-chat priority requires a
   paid fee before messaging opens. Super admin can close the token (see SUPER ADMIN section below). */
app.get('/api/admin/support',protect('restaurant_admin'),A(async(q,s)=>s.json(await SupportTicket.find({restaurant:q.user.restaurant}).sort('-createdAt'))));
app.get('/api/admin/support/:id',protect('restaurant_admin'),A(async(q,s)=>{const t=await SupportTicket.findOne({_id:q.params.id,restaurant:q.user.restaurant});if(!t)throw Error('Ticket not found');s.json(t)}));
app.post('/api/admin/support',protect('restaurant_admin'),A(async(q,s)=>{
  const {subject,message,priority}=q.body;if(!subject?.trim()||!message?.trim())throw Error('Enter a subject and message');
  const isInstant=priority==='instant';
  const ticket=await SupportTicket.create({restaurant:q.user.restaurant,token:genToken(),subject:subject.trim(),priority:isInstant?'instant':'normal',
    status:isInstant?'awaiting_payment':'open',feeAmount:isInstant?INSTANT_SUPPORT_FEE:0,feeStatus:isInstant?'pending':'none',
    messages:[{sender:'restaurant_admin',senderName:q.user.name,text:message.trim()}]});
  s.status(201).json(ticket);
}));
app.post('/api/admin/support/:id/messages',protect('restaurant_admin'),A(async(q,s)=>{
  const t=await SupportTicket.findOne({_id:q.params.id,restaurant:q.user.restaurant});if(!t)throw Error('Ticket not found');
  if(t.status==='closed')throw Error('This ticket has been closed by the ServeQR admin');
  if(t.status==='awaiting_payment')throw Error('Pay the instant support fee to start chatting');
  if(!q.body.text?.trim())throw Error('Enter a message');
  t.messages.push({sender:'restaurant_admin',senderName:q.user.name,text:q.body.text.trim()});await t.save();s.json(t);
}));
// Restaurant admin pays the instant-support fee (like the subscription flow: online = instant, upi/cash = pending super-admin confirmation).
app.post('/api/admin/support/:id/pay',protect('restaurant_admin'),A(async(q,s)=>{
  const t=await SupportTicket.findOne({_id:q.params.id,restaurant:q.user.restaurant});if(!t)throw Error('Ticket not found');
  if(t.feeStatus==='paid')throw Error('This ticket is already paid');
  const {method}=q.body;if(!['upi','cash','online'].includes(method))throw Error('Choose a payment method');
  t.feeMethod=method;
  if(method==='online'){t.feeStatus='paid';t.status='open'}else{t.feeStatus='pending_confirmation'}
  await t.save();s.json(t);
}));

/* ---------------- SUPER ADMIN ---------------- */
app.get('/api/super/dashboard',protect('super_admin'),A(async(q,s)=>{const a=await Restaurant.find();s.json({total:a.length,active:a.filter(x=>x.active).length,inactive:a.filter(x=>!x.active).length,subscriptions:a.filter(x=>x.subscriptionStatus==='active').length})}));
// Feature: super admin's restaurant list/detail surfaces name, status, subscription, any payment due, and expiry at a glance.
app.get('/api/super/restaurants',protect('super_admin'),A(async(q,s)=>{
  const restaurants=await Restaurant.find().sort('-createdAt');
  const pending=await SubscriptionPayment.find({status:'pending'}).sort('-createdAt');
  const pendingMap={};pending.forEach(p=>{const k=String(p.restaurant);if(!pendingMap[k])pendingMap[k]=p});
  s.json(restaurants.map(r=>{
    const daysLeft=r.expiryDate?Math.ceil((new Date(r.expiryDate)-new Date())/86400000):null;
    const p=pendingMap[String(r._id)];
    return {...r.toObject(),daysLeft,paymentDue:p?{amount:p.amount,method:p.method,planType:p.planType,createdAt:p.createdAt}:null};
  }));
}));
app.get('/api/super/restaurants/:id',protect('super_admin'),A(async(q,s)=>{const r=await Restaurant.findById(q.params.id);if(!r)throw Error('Restaurant not found');s.json(r)}));
app.post('/api/super/restaurants',protect('super_admin'),A(async(q,s)=>s.json(await Restaurant.create(q.body))));
app.patch('/api/super/restaurants/:id',protect('super_admin'),A(async(q,s)=>s.json(await Restaurant.findByIdAndUpdate(q.params.id,q.body,{new:true}))));
app.delete('/api/super/restaurants/:id',protect('super_admin'),A(async(q,s)=>{await Restaurant.findByIdAndDelete(q.params.id);await User.deleteMany({restaurant:q.params.id});await Table.deleteMany({restaurant:q.params.id});s.sendStatus(204)}));

/* Feature: super admin can completely modify any restaurant's menu content (categories, items) and its
   theme/design (colors, fonts, text, images — theme is just a field on Restaurant, updated via the
   generic PATCH /api/super/restaurants/:id route above). These mirror the restaurant-admin menu routes
   but are scoped by :id in the URL instead of the logged-in user's own restaurant. */
app.get('/api/super/restaurants/:id/menu',protect('super_admin'),A(async(q,s)=>s.json({categories:await Category.find({restaurant:q.params.id}).sort('sort'),items:await MenuItem.find({restaurant:q.params.id}).populate('category')})));
app.post('/api/super/restaurants/:id/categories',protect('super_admin'),A(async(q,s)=>s.json(await Category.create({...q.body,restaurant:q.params.id}))));
app.patch('/api/super/restaurants/:id/categories/:catId',protect('super_admin'),A(async(q,s)=>s.json(await Category.findOneAndUpdate({_id:q.params.catId,restaurant:q.params.id},q.body,{new:true}))));
app.delete('/api/super/restaurants/:id/categories/:catId',protect('super_admin'),A(async(q,s)=>{await Category.deleteOne({_id:q.params.catId,restaurant:q.params.id});s.sendStatus(204)}));
app.post('/api/super/restaurants/:id/items',protect('super_admin'),A(async(q,s)=>s.json(await MenuItem.create({...q.body,restaurant:q.params.id}))));
app.patch('/api/super/restaurants/:id/items/:itemId',protect('super_admin'),A(async(q,s)=>s.json(await MenuItem.findOneAndUpdate({_id:q.params.itemId,restaurant:q.params.id},q.body,{new:true}))));
app.delete('/api/super/restaurants/:id/items/:itemId',protect('super_admin'),A(async(q,s)=>{await MenuItem.deleteOne({_id:q.params.itemId,restaurant:q.params.id});s.sendStatus(204)}));

app.post('/api/super/restaurants/:id/setup',protect('super_admin'),A(async(q,s)=>{const {adminName,adminEmail,adminPassword,tableCount,googleReviewUrl}=q.body,r=await Restaurant.findById(q.params.id);if(!r)throw Error('Restaurant not found');if(googleReviewUrl!==undefined){r.googleReviewUrl=googleReviewUrl;await r.save()}let admin;if(adminEmail&&adminPassword){const password=await bcrypt.hash(adminPassword,10);admin=await User.findOneAndUpdate({restaurant:r._id,role:'restaurant_admin'},{name:adminName||'Restaurant Admin',email:adminEmail,password,role:'restaurant_admin',restaurant:r._id},{new:true,upsert:true,setDefaultsOnInsert:true})}let tables=[];const count=Math.max(0,Number(tableCount)||0);if(count){const existing=await Table.countDocuments({restaurant:r._id});tables=await Table.create(Array.from({length:count},(_,i)=>({restaurant:r._id,name:`Table ${existing+i+1}`,number:existing+i+1,qrToken:crypto.randomBytes(5).toString('hex')})))}s.json({restaurant:r,admin:admin&&{name:admin.name,email:admin.email},tables})}));
app.post('/api/super/restaurants/:id/payment',protect('super_admin'),A(async(q,s)=>{const expiryDate=new Date(Date.now()+2592000000),r=await Restaurant.findByIdAndUpdate(q.params.id,{active:true,subscriptionStatus:'active',expiryDate},{new:true});await Subscription.findOneAndUpdate({restaurant:r._id},{status:'active',expiryDate},{upsert:true});s.json(r)}));

/* Super admin reviews & confirms subscription payments raised by restaurant admins (Feature 7) */
app.get('/api/super/subscription-payments',protect('super_admin'),A(async(q,s)=>s.json(await SubscriptionPayment.find().populate('restaurant').sort('-createdAt'))));
app.patch('/api/super/subscription-payments/:id/confirm',protect('super_admin'),A(async(q,s)=>{
  const payment=await SubscriptionPayment.findById(q.params.id);if(!payment)throw Error('Payment not found');
  if(payment.status==='confirmed')throw Error('Already confirmed');
  payment.status='confirmed';await payment.save();
  const periodStart=payment.periodStart||new Date();
  const periodEnd=payment.periodEnd||new Date(periodStart.getTime()+planDuration(payment.planType));
  await Restaurant.findByIdAndUpdate(payment.restaurant,{active:true,subscriptionStatus:'active',planType:payment.planType||'monthly',subscriptionStartDate:periodStart,expiryDate:periodEnd});
  await Subscription.findOneAndUpdate({restaurant:payment.restaurant},{status:'active',expiryDate:periodEnd},{upsert:true});
  s.json(payment);
}));

/* Feature 1: super admin views full subscription detail (status, plan, dates, full payment history) for one restaurant */
app.get('/api/super/restaurants/:id/subscription',protect('super_admin'),A(async(q,s)=>{
  const restaurant=await Restaurant.findById(q.params.id);if(!restaurant)throw Error('Restaurant not found');
  const payments=await SubscriptionPayment.find({restaurant:q.params.id}).sort('-createdAt');
  const daysLeft=restaurant.expiryDate?Math.ceil((new Date(restaurant.expiryDate)-new Date())/86400000):null;
  s.json({restaurant,payments,daysLeft,planAmounts:{monthly:PLAN_AMOUNT,annual:PLAN_AMOUNT_ANNUAL}});
}));

/* Feature 2: super admin manually grants/edits a subscription for an exact date range, monthly or annual */
app.post('/api/super/restaurants/:id/subscription',protect('super_admin'),A(async(q,s)=>{
  const {startDate,endDate,planType}=q.body;
  if(!startDate||!endDate)throw Error('Choose a start and end date');
  const start=new Date(startDate),end=new Date(endDate);
  if(isNaN(+start)||isNaN(+end))throw Error('Invalid dates');
  if(end<=start)throw Error('End date must be after the start date');
  const plan=planType==='annual'?'annual':'monthly';
  const restaurant=await Restaurant.findByIdAndUpdate(q.params.id,{active:true,subscriptionStatus:'active',planType:plan,subscriptionStartDate:start,expiryDate:end},{new:true});
  if(!restaurant)throw Error('Restaurant not found');
  await Subscription.findOneAndUpdate({restaurant:restaurant._id},{status:'active',expiryDate:end},{upsert:true});
  const payment=await SubscriptionPayment.create({restaurant:restaurant._id,amount:planAmount(plan),method:'manual_grant',planType:plan,periodStart:start,periodEnd:end,status:'confirmed',transactionId:'MANUAL-'+genTxnId()});
  s.json({restaurant,payment});
}));

/* Feature 4: super admin sends a subscription reminder to a specific restaurant — appears in that restaurant admin's notification bell */
app.post('/api/super/restaurants/:id/reminder',protect('super_admin'),A(async(q,s)=>{
  const restaurant=await Restaurant.findById(q.params.id);if(!restaurant)throw Error('Restaurant not found');
  const daysLeft=restaurant.expiryDate?Math.ceil((new Date(restaurant.expiryDate)-new Date())/86400000):null;
  const fallback=daysLeft==null?'Please renew your ServeQR subscription to keep taking orders.':daysLeft<0?`Your ServeQR subscription expired ${Math.abs(daysLeft)} day(s) ago. Renew now to keep taking orders.`:`Your ServeQR subscription expires in ${daysLeft} day(s). Renew soon to avoid interruption.`;
  const message=(q.body.message||'').trim()||fallback;
  const notification=await Notification.create({restaurant:restaurant._id,type:'subscription_reminder',title:'Subscription reminder from ServeQR',message});
  s.status(201).json(notification);
}));

/* Super admin's own notification feed — alerts raised when a restaurant admin subscribes/renews (Feature 3) */
app.get('/api/super/notifications',protect('super_admin'),A(async(q,s)=>{
  const [notifications,unread]=await Promise.all([
    SuperAdminNotification.find().sort('-createdAt').limit(50).populate('restaurant','name slug'),
    SuperAdminNotification.countDocuments({read:false})]);
  s.json({notifications,unread});
}));
app.patch('/api/super/notifications/:id/read',protect('super_admin'),A(async(q,s)=>s.json(await SuperAdminNotification.findOneAndUpdate({_id:q.params.id},{read:true},{new:true}))));
app.post('/api/super/notifications/read-all',protect('super_admin'),A(async(q,s)=>{await SuperAdminNotification.updateMany({read:false},{read:true});s.json({ok:true})}));

/* Feature 5: platform-wide analytics — order revenue, subscription revenue, plan mix, top restaurants, upcoming expiries */
app.get('/api/super/analytics',protect('super_admin'),A(async(q,s)=>{
  const [restaurants,paidOrders,confirmedPayments]=await Promise.all([Restaurant.find(),Order.find({paymentStatus:'paid'}),SubscriptionPayment.find({status:'confirmed'})]);
  const orderRevenue=paidOrders.reduce((a,o)=>a+o.total,0);
  const subscriptionRevenue=confirmedPayments.reduce((a,p)=>a+p.amount,0);
  const revByRestaurant={},ordersByRestaurant={};
  paidOrders.forEach(o=>{const k=String(o.restaurant);revByRestaurant[k]=(revByRestaurant[k]||0)+o.total;ordersByRestaurant[k]=(ordersByRestaurant[k]||0)+1});
  const topRestaurants=restaurants.map(r=>({id:r._id,name:r.name,revenue:revByRestaurant[String(r._id)]||0,orders:ordersByRestaurant[String(r._id)]||0}))
    .sort((a,b)=>b.revenue-a.revenue).slice(0,8);
  const now=new Date(),months=[];
  for(let i=5;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1);months.push({key:`${d.getFullYear()}-${d.getMonth()}`,label:d.toLocaleString('default',{month:'short'}),amount:0})}
  confirmedPayments.forEach(p=>{const d=new Date(p.createdAt),key=`${d.getFullYear()}-${d.getMonth()}`,m=months.find(x=>x.key===key);if(m)m.amount+=p.amount});
  const planBreakdown={monthly:0,annual:0};restaurants.forEach(r=>{planBreakdown[r.planType==='annual'?'annual':'monthly']++});
  const expiringSoon=restaurants.filter(r=>r.active&&r.subscriptionStatus==='active'&&r.expiryDate&&(new Date(r.expiryDate)-now)/86400000<=7&&(new Date(r.expiryDate)-now)>=0)
    .map(r=>({id:r._id,name:r.name,daysLeft:Math.ceil((new Date(r.expiryDate)-now)/86400000)})).sort((a,b)=>a.daysLeft-b.daysLeft);
  const expiredCount=restaurants.filter(r=>!r.active||r.subscriptionStatus==='inactive'||!r.expiryDate||new Date(r.expiryDate)<now).length;
  s.json({totalRestaurants:restaurants.length,activeRestaurants:restaurants.filter(r=>r.active).length,
    orderRevenue,subscriptionRevenue,confirmedPaymentCount:confirmedPayments.length,
    monthlyTrend:months,topRestaurants,planBreakdown,expiringSoon,expiredCount});
}));

/* Support — super admin sees every restaurant's tickets, replies, confirms instant-fee payments, and can
   close a token to end the thread (Feature: support). */
app.get('/api/super/support',protect('super_admin'),A(async(q,s)=>{
  const filter={};if(q.query.status)filter.status=q.query.status;
  s.json(await SupportTicket.find(filter).sort('-createdAt').populate('restaurant','name slug'));
}));
app.get('/api/super/support/:id',protect('super_admin'),A(async(q,s)=>{const t=await SupportTicket.findById(q.params.id).populate('restaurant','name slug');if(!t)throw Error('Ticket not found');s.json(t)}));
app.post('/api/super/support/:id/messages',protect('super_admin'),A(async(q,s)=>{
  const t=await SupportTicket.findById(q.params.id);if(!t)throw Error('Ticket not found');
  if(t.status==='closed')throw Error('This ticket is closed');
  if(!q.body.text?.trim())throw Error('Enter a message');
  t.messages.push({sender:'super_admin',senderName:q.user.name,text:q.body.text.trim()});await t.save();
  s.json(await t.populate('restaurant','name slug'));
}));
app.patch('/api/super/support/:id/confirm-payment',protect('super_admin'),A(async(q,s)=>{
  const t=await SupportTicket.findById(q.params.id);if(!t)throw Error('Ticket not found');
  if(t.feeStatus==='paid')throw Error('Already paid');
  t.feeStatus='paid';t.status='open';await t.save();s.json(t);
}));
app.patch('/api/super/support/:id/close',protect('super_admin'),A(async(q,s)=>{
  const t=await SupportTicket.findByIdAndUpdate(q.params.id,{status:'closed',closedAt:new Date()},{new:true});
  if(!t)throw Error('Ticket not found');s.json(t);
}));

/* Auto-cancel counter orders that were never paid within the 10-minute window (Feature: customer pay-at-counter) */
async function autoCancelUnpaidOrders(){try{const expired=await Order.find({status:'awaiting_payment',paymentDueAt:{$lt:new Date()}}).populate('table');for(const o of expired){o.status='cancelled';await o.save();await Notification.create({restaurant:o.restaurant,order:o._id,table:o.table?._id,type:'order_cancelled',title:`Order auto-cancelled · ${o.table?.name||'Table'}`,message:'Guest did not pay at the counter within 10 minutes'})}}catch(e){console.error('auto-cancel error',e.message)}}

// 404 + centralized error handler (after every route) so unexpected errors never leak stack
// traces to the client and always return consistent JSON.
app.use((q,s)=>s.status(404).json({message:'Not found'}));
app.use((err,q,s,n)=>{console.error(err);s.status(err.status||500).json({message:err.message||'Something went wrong'})});

const PORT=process.env.PORT||5000;
mongoose.connect(process.env.MONGODB_URI)
  .then(()=>{
    const server=app.listen(PORT,()=>console.log(`API running on ${PORT}`));
    const cancelInterval=setInterval(autoCancelUnpaidOrders,30000);
    const shutdown=()=>{console.log('Shutting down gracefully...');clearInterval(cancelInterval);server.close(()=>mongoose.connection.close(false).then(()=>process.exit(0)))};
    process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
  })
  .catch(e=>{console.error('MongoDB connection failed:',e.message);process.exit(1)});
