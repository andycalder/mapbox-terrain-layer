class TerrainLayer {
    constructor(rasterSource, demSource) {
        this.id = 'terrain';
        this.type = 'custom';
        this.rasterSource = rasterSource;
        this.demSource = demSource;
    }
    
    onAdd(map, gl) {
        this.map = map;
        this.rasterSourceCache = map.style.sourceCaches[this.rasterSource];
        this.demSourceCache = map.style.sourceCaches[this.demSource];
        
        this.rasterSourceCache.pause();
        this.demSourceCache.pause();

        this.prepareShaders(gl);
        this.prepareBuffers(gl);
    }

    update() {
        const transform = this.map.transform.clone();
        const pitchOffset = transform.cameraToCenterDistance * Math.sin(transform._pitch);
        transform.height = transform.height + pitchOffset;
        
        this.rasterSourceCache._paused = false;
        this.demSourceCache._paused = false;

        this.rasterSourceCache.used = true;
        this.demSourceCache.used = true;

        this.rasterSourceCache.update(transform);
        this.demSourceCache.update(transform);
        
        this.rasterSourceCache.pause();
        this.demSourceCache.pause();
    }

    getCenterElevation() {
        const transform = this.map.transform;
        const demZoom = this.demSourceCache.getZoom(transform);
        console.log(demZoom);
        this.pixelPoint = this.demSourceCache.transform.point;
        this.tiley = this.pixelPoint.y / 512;
    }

    prepareBuffers(gl) {
        const n = 64;

        this.vertexArray = new Int16Array(n * n * 2);
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                const vertex = [j * (8192 / (n - 1)), i * (8192 / (n - 1))];
                const offset = (i * n + j) * 2;
                this.vertexArray.set(vertex, offset);
            }
        }

        this.vertexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.vertexArray.buffer, gl.STATIC_DRAW);
        
        this.indexArray = new Uint16Array((n - 1) * (n - 1) * 6);
        let offset = 0;
        for (let i = 0; i < n - 1; i++) {
            for (let j = 0; j < n - 1; j++) {
                const index = i * n + j;
                const quad = [index, index + 1, index + n, index + n, index + 1, index + n + 1];
                this.indexArray.set(quad, offset);
                offset+=6;
            }
        }

        this.indexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indexArray.buffer, gl.STATIC_DRAW);
    }

    prepareShaders(gl) {
        var vertexSource = `
        uniform mat4 u_matrix;
        uniform sampler2D u_raster;
        uniform sampler2D u_dem;
        uniform float u_scale;
        uniform vec2 u_offset;

        attribute vec2 a_pos;
        varying vec2 v_pos;

        float getElevation(vec2 coord) {
            // Convert encoded elevation value to meters
            vec4 data = texture2D(u_dem, coord) * 255.0;
            return (data.r + data.g * 256.0 + data.b * 256.0 * 256.0) - 65536.0;
        }

        void main() {
            v_pos = vec2(a_pos / 8192.0);
            vec2 demCoord = (v_pos + u_offset) * u_scale * 0.5 + 0.25;
            gl_Position = u_matrix * vec4(a_pos, getElevation(demCoord) - 2200.0, 1.0);
        }`

        var fragmentSource = `
        precision highp float;

        uniform sampler2D u_raster;
        uniform sampler2D u_dem;

        varying vec2 v_pos;

        void main() {
            gl_FragColor = vec4(texture2D(u_raster, v_pos).rgb, 1.0);
        }`

        var vertexShader = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vertexShader, vertexSource);
        gl.compileShader(vertexShader);
        var fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fragmentShader, fragmentSource);
        gl.compileShader(fragmentShader);

        this.program = gl.createProgram();
        gl.attachShader(this.program, vertexShader);
        gl.attachShader(this.program, fragmentShader);
        gl.linkProgram(this.program);

        this.aPos = gl.getAttribLocation(this.program, "a_pos");
    }

    demTexture(gl, tile) {
        if (!tile.demTexture) {
            tile.demTexture = gl.createTexture();
        }

        if (tile.needsHillshadePrepare) {
            const pixels = tile.dem.getPixels();
            gl.bindTexture(gl.TEXTURE_2D, tile.demTexture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tile.dem.stride, tile.dem.stride, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels.data);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            tile.needsHillshadePrepare = false;
        }
    
        return tile.demTexture;
    }

    render(gl, matrix) {
        gl.useProgram(this.program);

        // Enable depth test
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.depthFunc(gl.LEQUAL);
        
        // Enable back face culling
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
        gl.frontFace(gl.CW);

        // Bind vertex buffer
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.enableVertexAttribArray(this.aPos);
        gl.vertexAttribPointer(this.aPos, 2, gl.SHORT, false, 0, 0);

        // Bind index buffer
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);

        this.update();
        this.getCenterElevation();
        
        let coords = this.rasterSourceCache.getVisibleCoordinates().reverse();
        coords = coords.filter(coord => 
            !this.rasterSourceCache.findLoadedParent(coord, 0)
            && this.demSourceCache.findLoadedParent(coord, 0)
        );

        for (const coord of coords) {
            const rasterTile = this.rasterSourceCache.getTile(coord);
            const demTile = this.demSourceCache.findLoadedParent(coord, 0);

            // Bind raster texture to unit 0
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, rasterTile.texture.texture);
            gl.uniform1i(gl.getUniformLocation(this.program, 'u_raster'), 0);

            // Bind dem texture to unit 1
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.demTexture(gl, demTile));
            gl.uniform1i(gl.getUniformLocation(this.program, 'u_dem'), 1);
            
            // Calculate dem texture offset
            const deltaZoom = rasterTile.tileID.canonical.z - demTile.tileID.canonical.z;
            const demScale = 1 / Math.pow(2, deltaZoom);
            const xOffset = rasterTile.tileID.canonical.x - demTile.tileID.canonical.x / demScale;
            const yOffset = rasterTile.tileID.canonical.y - demTile.tileID.canonical.y / demScale;

            gl.uniform1f(gl.getUniformLocation(this.program, "u_scale"), demScale);
            gl.uniform2f(gl.getUniformLocation(this.program, "u_offset"), xOffset, yOffset);

            // Bind matrix
            gl.uniformMatrix4fv(gl.getUniformLocation(this.program, "u_matrix"), false, coord.posMatrix);

            // Draw
            const vertexCount = this.indexArray.length;
            const type = gl.UNSIGNED_SHORT;
            const offset = 0;
            gl.drawElements(gl.TRIANGLES, vertexCount, type, offset);
        }
    }
}