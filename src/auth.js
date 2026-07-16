import jwt from 'jsonwebtoken';
import {User} from './models.js';
export const tokenFor=u=>jwt.sign(
    {id:u._id,role:u.role,restaurant:u.restaurant},
    process.env.JWT_SECRET||'prototype-secret',
 {expiresIn:'7d'});

export const protect=
(...roles)=>async(req,res,next)=>
    {
        try
        {const raw=req.headers.authorization?.split(' ')[1],data=jwt.verify(raw,process.env.JWT_SECRET||'prototype-secret'),u=await User.findById(data.id);
    if(!u||(roles.length&&!roles.includes(u.role)))
    return res.status(403).json({message:'Access denied'})
    ;req.user=u;next()
}
    catch{res.status(401).json({message:'Please sign in'})}};
