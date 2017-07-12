var reload = require('../lib/reload')//replace with just reload for package use
var path = require('path')
var publicDir = path.join(__dirname, 'public')

var options = {
  onReload:()=>console.log('reload occured at ' + new Date().toTimeString().slice(0, 8))
}

reload(publicDir,options).then(function(){
  console.log('Server started at ' + new Date().toTimeString().slice(0, 8))
})
.catch(e=>console.error(e))