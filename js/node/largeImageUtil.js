/*  LICENSE
    
    _This file is Copyright 2018 by the Image Processing and Analysis Group (BioImage Suite Team). Dept. of Radiology & Biomedical Imaging, Yale School of Medicine._
    
    BioImage Suite Web is licensed under the Apache License, Version 2.0 (the "License");
    
    - you may not use this software except in compliance with the License.
    - You may obtain a copy of the License at [http://www.apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0)
    
    __Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.__
    
    ENDLICENSE */

'use strict';

const baseutils=require("baseutils");
const BisWebImage = require('bisweb_image.js');
const fs=require('fs');
const zlib=require('zlib');
const bisgenericio=require('bis_genericio.js');
const rimraf=require('rimraf');
const tmpPackage=require('tmp');

/**
 * A set of utility functions to handle large image load and process
 * @namespace largeImageUtil
 */

/**
 * Code to load and stream large images
 */
const processChunk = async (params,buffer) => {

    //console.log('+++ In largeImageUtil.processChunk',buffer.length);
    
    let newbuf=new Uint8Array(buffer);
    let len=newbuf.length;
    
    
    let storeData=(in_offset,out_offset,length) => {
        for (let i=0;i<length;i++)
            params['temp'][out_offset+i]=newbuf[i+in_offset];
    };

    // How much can we add
    let done=false;

    while (!done) {
        let available=len-params['offset'];
        let maxneeded=params['volumebytesize']-params['added'];
        let length=available;
        let in_offset=params['offset'];



        
        if (maxneeded<available) {
            length=maxneeded;
            params['offset']+=length;
        } else {
            params['offset']=0;
        }

        storeData(in_offset,params['added'],length);
        params['added']=params['added']+length;
        let extraneeded=params['volumebytesize']-params['added'];

        //console.log('+++ In  loop ',extraneeded);
        
        if (extraneeded<1) {
            //console.log('Calling object.framecallback',params['frame']);
            let finished=await params['processFrameCallbackObject'].processFrame(params['frame'],params['tmpImage']);
            params['frame']+=1;
            params['added']=0;
            //console.log('____ done calling processFrameCallbackObject',params['frame'],params['added'],finished);
            if (finished) {
                return Promise.resolve(true);
            }
            
        }
        
        available=available-length;
        if (available<1) {
            //console.log('Checking for available',available);
            params['offset']=0;
            done=true;
        }

    }

    //console.log('Done with processChunk',params['offset'],params['frame']);
    return Promise.resolve(false);
};



const readAndProcessFile = async (params) => {

    let gzip=false;
    if (params.inputname.split('.').pop()==='gz') {
        gzip=true;
    }
    
    params['frame']=params['frameoffset'];
    params['offset']=params['headersize'];
    params['added']=0;
    params['leftover']=0;

    let readstream = fs.createReadStream(params.inputname).on('error', (e) => {
        console.log('Error=',e);
        return Promise.reject('error'+e);
    });

    let finished=false;
    let processing=false;

    return new Promise( (resolve,reject) => {
        
        if (gzip) {
            const gunzip = zlib.createGunzip();
            readstream.pipe(gunzip);
            
            gunzip.on('data', (chunk) => {
                // console.log('++ Read chunk finished=',finished);
                if (!finished) {
                    processing=true;
                    //console.log('+++\n+++\n+++ Calling processed frame',params['frame']);
                    processChunk(params,chunk).then( (ok) => {
                        processing=false;
                        //console.log('++++ \t done processed frame',params['frame'],ok);
                        
                        if (ok) {
                            //console.log('____ Finished with processChunk');
                            finished=true;
                            /*gunzip.on('end', () => {});
                              gunzip.on('data', () => {});*/
                            resolve('Done processChunk');
                        }
                    }).catch( (e) => {
                        console.log('Error reading',e);
                        reject(e);
                    });
                }
            });
            gunzip.on('error', () => {
                console.log('Error gunzip');
                process.exit(0);
                reject('Done');
            });
            gunzip.on('end', () => {
                //console.log('Gunzip is done ... ');
                //resolve('Done gunzip');
            });
        } else {
            
            readstream.on('end',  () => {
                resolve('Done readstream');
            });
            
            readstream.on('readable', async () => {
                let done=false;
                while (!done) {
                    let chunk = readstream.read();
                    if (chunk && !finished) {
                        let ok=await processChunk(params,chunk);
                        if (ok) {
                            finished=true;
                            resolve('Done readstream processChunk');
                            return;
                        }
                    } else {
                        done=true;
                    }
                }
            });
        }
    });
};


/**
 * String inputname -- name of largeimage
 * Function callbackObject -- function to call with new frames
 */
const readAndProcessLargeImage = async (inputname,callbackObject,totalframes=-1,frameoffset=-1) => {

    let input=new BisWebImage();
    let headerinfo=null;
    try {
        headerinfo=await input.loadHeaderOnly(inputname,true);
    } catch(e) {
        return Promise.reject('Failed to read header of '+inputname);
    }

    let dims=input.getDimensions();

    if (totalframes<0)
        totalframes=dims[3]*dims[4];
    if (frameoffset<0)
        frameoffset=0;

    let params= {
        numframes : dims[3]*dims[4],
        totalframes : totalframes,
        frameoffset : frameoffset,
        voxelsize : headerinfo.type.size,
        volumesize : dims[0]*dims[1]*dims[2],
        headersize : headerinfo.headerlength,
        swap : headerinfo.swap,
        processFrameCallbackObject : callbackObject,
        inputname : inputname,
        input : input
    };

    
    if (params.swap) {
        return Promise.reject('Can not handle byte swapped data');
    }

    params['volumebytesize']=params.volumesize*params.voxelsize;
    params['temp']=new Uint8Array(params['volumebytesize']);
    params['tmpImage']=new BisWebImage();
    params['tmpImage'].cloneImage(params['input'],
                                  {
                                      "numframes" : 1,
                                      "numcomponents" : 1,
                                      "buffer" : params['temp'].buffer
                                  }, true);
    

    
    try {
        //console.log('Calling readAndProcessFile',params['inputname']);
        let d=await readAndProcessFile(params);
        //console.log('Calling readAndProcessFile',params['inputname'],d);
    } catch(e) {
        console.log('Failed',e);
        return Promise.reject(e);
    }
    
    return Promise.resolve('Done process Large Image');
};


const createInitialImageOutput =  (firstImage,dt=null,numframes=0,numcomponents=0) =>{


    let tempImage=new BisWebImage();
    tempImage.cloneImage(firstImage,
                         {
                             "numframes" : numframes,
                             "numcomponents" : numcomponents,
                             "onlyheader" : true,
                             "newniftytype" : dt
                         },true);
    tempImage.setCommentList(firstImage.getCommentList());
    //console.log(JSON.stringify(tempImage.getCommentList(),null,2));
    return tempImage;
};

const saveInitialImageHeader =  (tempImage,numframes=1) => { 

    let hd=tempImage.getHeader();
    hd.setExtensionsFromArray(tempImage.getCommentList());
    let headerdata=tempImage.getHeaderData(true,numframes);

    let tempfname=tmpPackage.tmpNameSync();
    let numbytes=0;
    let fd=null;
    try {
        fd = fs.openSync(tempfname, 'w');
        let buf = bisgenericio.createBuffer(headerdata.data);
        let l=fs.writeSync(fd, buf);
    } catch(e) {
        return [ null,e ];
    }

    return [ fd, tempfname, numbytes ];
};

const writeSubsequentFrame =(filehandle,imageFrame,last=false,debug=false) => {

    let rawdata=imageFrame.getRawData();
    try {
        let buf = bisgenericio.createBuffer(rawdata);
        let l=fs.writeSync(filehandle['fd'],buf)
        filehandle['numbytes']+=l;
        if (debug)
            console.log('____ writing ',l,'bytes');
    } catch(e) {
        console.log(e);
        return 0;
    }

    return rawdata.length;
};

const compressFile= (infilename,outname,deleteold=true)  => {

    let success=false;
    let index=outname.lastIndexOf('.gz');
    if (index<2) {
        return new Promise( (resolve,reject) => {
            try {
                console.log('____ executing copy '+infilename+' '+outname);
                fs.copyFileSync(infilename,outname);
                success=true;
            } catch(e) {
                console.log(e);
            }
            if (deleteold)
                rimraf.sync(infilename);
            if (success)
                resolve(true);
            else
                reject(false);
        })
    }

  
    return new Promise( (resolve,reject) => {
        console.log('____ executing gzip '+infilename+' '+outname);
        let w=fs.createWriteStream(outname);
        let d=zlib.createGzip();
        
        fs.createReadStream(infilename)
            .pipe(d)
            .pipe(w)
            .on('error', (e) => {
                console.log(e);
                reject(false);
            })
        
        w.on('finish', () => {
            rimraf.sync(infilename);
            console.log('____ gzip completed');
            resolve(true);
        }).on('error', (e) => {
            console.log('w error',e);
            reject(false);
        });


    });
};
                                       

const writeOutput=async (frame,numframes,outputname,imageToSave,fileHandle,debug=false,partialframes=-1) => {

    fileHandle['done']= fileHandle['done'] || false;
    
    if (fileHandle['done'])
        return false;
        
   
    if (partialframes<0)
        partialframes=numframes;

    //console.log('________________ Write Output',frame,'/',numframes,' done=',fileHandle['done']);
    

    
    if (frame===0) {
        console.log('____ writing header to',outputname,imageToSave.getDescription());
        let tmp=createInitialImageOutput(imageToSave);
        let fh=saveInitialImageHeader(tmp,numframes);
        fileHandle['fd']=fh[0];
        fileHandle['filename']=fh[1];
        fileHandle['numbytes']=fh[2];
        fileHandle['done']=false;
    }

    let last=false;
    if (frame === numframes-1) {
        last=true;
        fileHandle['done']=true;
        //console.log('Last =',last,frame,numframes-1,fileHandle['done']);
    }
    
    
    if (debug || last)
        console.log('____ writing frame (last=',last,')', frame+1,'/',numframes);


    await writeSubsequentFrame(fileHandle,imageToSave,last, false);

    if (last) {
        fs.closeSync(fileHandle['fd']);
        console.log('____ File ',fileHandle['filename'],'closed numbytes=',fileHandle['numbytes']);
        await compressFile(fileHandle['filename'],outputname,true);
    }

     let piecelast=last;
    
    if (frame+1 === partialframes)
        piecelast=true;
 
    //console.log('____ Last=',last,' frame=',frame+1,'/',numframes,'(p=',partialframes,') piecelast=',piecelast);
    
    return Promise.resolve(piecelast);
    
    /*    let piecelast=last;
    if (frame+1 === partialframes)
        piecelast=true;

    return new Promise( (resolve,reject) => {
        writeSubsequentFrame(fileHandle,imageToSave,last, false);
        console.log('____ Last=',last,' frame=',frame+1,'/',numframes,'(p=',partialframes,') piecelast=',piecelast);            
        if (last) {
            fs.closeSync(fileHandle['fd']);
            console.log('____ File ',fileHandle['filename'],'closed numbytes=',fileHandle['numbytes']);
            compressFile(fileHandle['filename'],outputname,true).then( () => {
                console.log('____\t Done Storing File ',outputname);
                resolve(true);
            }).catch( (e) => {
                reject(e);
            })
        } else {
            resolve(false);
        }
    });*/

};


// TODO: Implement logic for naming images intelligently
const createOutputFilename= function(existingname,inputname,extra,extension='.nii.gz')  {

    existingname=existingname || '';
    if (existingname.length>3)
        return existingname;

    let outputname='';
    let fn=inputname || 'something.nii.gz';
    if (fn.length>1) {
        let ext = fn.split('.').pop();
        if (ext==="gz") {
            fn=fn.substr(0,fn.length-3);
            ext = fn.split('.').pop();
        }
        outputname=fn.substr(0,fn.length-(ext.length+1));
    }
    
    let nm=extra || 'extra';
    nm=nm.toLowerCase();

    return outputname+'__'+nm+extension;
};

module.exports = {
    readAndProcessLargeImage : readAndProcessLargeImage,
    createInitialImageOutput : createInitialImageOutput,
    saveInitialImageHeader : saveInitialImageHeader,
    writeSubsequentFrame : writeSubsequentFrame,
    compressFile : compressFile,
    writeOutput : writeOutput,
    createOutputFilename :     createOutputFilename
};
